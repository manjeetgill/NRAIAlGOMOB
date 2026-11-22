/**
 * Sign-in screen
 *
 * Talks to the same email/password endpoint as the web login, including the
 * authenticator-code step the server only reveals after a correct password.
 */

import React, { useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { LoginRequest, LoginResponse } from "@nraialgo/shared/api";
import type { User } from "@nraialgo/shared/api";
import { useAuthStore } from "@nraialgo/shared/stores";
import { useTheme } from "@/components/ThemeProvider";
import { useApi } from "@/hooks/useApi";
import { getApiClient } from "@/utils/apiClient";

const SIGN_IN_FAILED = "Sign-in was not confirmed. Check your connection and try again.";

// myalgodesk.in sends no Access-Control-Allow-* headers, so only a native client may call it.
const BROWSER_BUILD = "Sign-in cannot work in a browser build. Open this app in Expo Go on the phone.";

/** The server explains refusals in `message`; a transport failure has nothing to say. */
function reasonFor(caught: unknown): string {
  const error = caught as { details?: unknown; message?: string; status?: unknown } | undefined;
  const details = error?.details;
  if (details && typeof details === "object" && "message" in details) {
    const message = String((details as Record<string, unknown>).message);
    if (message) return message;
  }
  if (Platform.OS === "web" && error?.status === undefined) return BROWSER_BUILD;
  // "Check your connection" is a guess; the thrown message is a fact, so show both.
  const underlying = error?.message;
  return underlying && underlying !== SIGN_IN_FAILED
    ? `${SIGN_IN_FAILED} (${underlying})`
    : SIGN_IN_FAILED;
}

export default function LoginScreen() {
  const { resolvedTheme } = useTheme();
  const { useLogin } = useApi();
  const login = useLogin({ retry: 0 });
  const inFlight = useRef(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [remember, setRemember] = useState(true);
  const [factorRequired, setFactorRequired] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dark = resolvedTheme === "dark";
  const colors = dark
    ? { bg: "#0f172a", text: "#f1f5f9", muted: "#94a3b8", dim: "#64748b", field: "#0b1220",
        border: "#334155", accent: "#38bdf8", note: "#64748b", errorBorder: "rgba(239,68,68,0.45)",
        errorBg: "rgba(239,68,68,0.09)", errorText: "#fecaca" }
    : { bg: "#f8fafc", text: "#0f172a", muted: "#475569", dim: "#64748b", field: "#ffffff",
        border: "#cbd5e1", accent: "#0284c7", note: "#64748b", errorBorder: "rgba(239,68,68,0.45)",
        errorBg: "rgba(239,68,68,0.06)", errorText: "#b91c1c" };

  const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    content: { flexGrow: 1, justifyContent: "center", padding: 20, paddingBottom: 40 },
    brand: { fontSize: 24, fontWeight: "700", color: colors.text },
    sub: { fontSize: 15, color: colors.muted, marginTop: 2, marginBottom: 22 },
    field: { marginBottom: 12 },
    label: { fontSize: 13, fontWeight: "600", color: colors.muted, marginBottom: 5 },
    input: { height: 42, borderRadius: 8, borderWidth: 1, borderColor: colors.border,
      backgroundColor: colors.field, paddingHorizontal: 12, fontSize: 16, color: colors.text },
    inputDisabled: { borderColor: colors.accent, backgroundColor: dark ? "#111c30" : "#f1f5f9",
      color: colors.muted },
    passwordRow: { flexDirection: "row", alignItems: "center", height: 42, borderRadius: 8,
      borderWidth: 1, borderColor: colors.border, backgroundColor: colors.field, paddingLeft: 12 },
    passwordRowError: { borderColor: "#7f1d1d" },
    passwordInput: { flex: 1, fontSize: 16, color: colors.text, paddingVertical: 0 },
    toggle: { paddingHorizontal: 10, paddingVertical: 8 },
    toggleText: { fontSize: 12, fontWeight: "600", color: colors.accent },
    hint: { fontSize: 12, color: colors.dim, marginTop: 6 },
    checkRow: { flexDirection: "row", alignItems: "flex-start", gap: 7, marginTop: 9 },
    checkBox: { width: 16, height: 16, borderRadius: 3, borderWidth: 1, borderColor: colors.border,
      alignItems: "center", justifyContent: "center" },
    checkText: { flex: 1, fontSize: 12, color: colors.muted },
    button: { height: 44, borderRadius: 8, backgroundColor: "#0284c7", alignItems: "center",
      justifyContent: "center", marginTop: 16 },
    buttonDisabled: { backgroundColor: dark ? "#1e293b" : "#e2e8f0" },
    buttonBusy: { backgroundColor: "#0b5f86" },
    buttonText: { fontSize: 16, fontWeight: "700", color: "#ffffff" },
    buttonDisabledText: { color: dark ? "#475569" : "#94a3b8" },
    buttonBusyText: { fontSize: 16, fontWeight: "700", color: "#cfe9f5" },
    errorBox: { borderWidth: 1, borderColor: colors.errorBorder, backgroundColor: colors.errorBg,
      borderRadius: 8, paddingHorizontal: 11, paddingVertical: 9, marginTop: 14 },
    errorText: { fontSize: 13, color: colors.errorText },
    note: { fontSize: 12, color: colors.note, marginTop: 20, borderTopWidth: 1,
      borderTopColor: colors.border, paddingTop: 12 },
  });

  const codeReady = otp.trim().length >= 6;
  const canSubmit = email.trim().length > 0 && password.length > 0 && (!factorRequired || codeReady);
  // A dimmed "Sign in" while the server waits for a code reads as a refusal.
  const waitingForCode = factorRequired && !codeReady;

  async function handleSubmit() {
    if (inFlight.current || !canSubmit) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);

    const body: LoginRequest = {
      email: email.trim(),
      password,
      ...(otp.trim() ? { otp: otp.trim(), remember } : {}),
    };
    let signedIn = false;

    try {
      const result: LoginResponse = await login.mutateAsync(body);
      if (result?.mfaRequired === true) {
        setFactorRequired(true);
        setOtp("");
        return;
      }
      if (typeof result?.mfaEnrollmentRequired !== "boolean") {
        throw new Error(`myalgodesk.in sent an unexpected sign-in response: ${JSON.stringify(result)}`);
      }
      // The session lives in a cookie, so the proof of sign-in is the server's own identity read.
      // Saying "password worked" here matters: it separates a rejected password from a
      // session that was issued but not kept, which the server's 401 text cannot express.
      let me: User;
      try {
        me = await getApiClient().get<User>("/v1/auth/me");
      } catch {
        throw new Error("Your password was accepted but the session did not stick. Try again.");
      }
      useAuthStore.getState().setUser(me);
      setPassword("");
      setOtp("");
      signedIn = true;
      router.replace("/(tabs)/portfolio");
    } catch (caught) {
      setPassword("");
      setOtp("");
      setError(reasonFor(caught));
    } finally {
      inFlight.current = false;
      if (!signedIn) setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>MyAlgoDesk</Text>
        <Text style={styles.sub}>Sign in</Text>

        <View style={styles.field}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={[styles.input, factorRequired && styles.inputDisabled]}
            value={email}
            onChangeText={(value) => { setEmail(value); setFactorRequired(false); setOtp(""); }}
            placeholder="you@example.com"
            placeholderTextColor={colors.dim}
            editable={!factorRequired && !busy}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            maxLength={254}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Password</Text>
          <View style={[styles.passwordRow, !!error && styles.passwordRowError]}>
            <TextInput
              style={styles.passwordInput}
              value={password}
              onChangeText={(value) => { setPassword(value); setFactorRequired(false); setOtp(""); }}
              secureTextEntry={!showPassword}
              autoComplete="current-password"
              textContentType="password"
              editable={!busy}
              maxLength={1024}
            />
            <TouchableOpacity
              style={styles.toggle}
              onPress={() => setShowPassword((current) => !current)}
              disabled={busy}
              hitSlop={8}
            >
              <Text style={styles.toggleText}>{showPassword ? "Hide password" : "Show password"}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {factorRequired && (
          <View style={styles.field}>
            <Text style={styles.label}>Authenticator or recovery code</Text>
            <TextInput
              style={styles.input}
              value={otp}
              onChangeText={(value) => setOtp(value.trim())}
              secureTextEntry
              editable={!busy}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="one-time-code"
              maxLength={64}
            />
            <Text style={styles.hint}>
              Password accepted. Enter a code from your authenticator app, or one unused recovery code. No email code is needed to sign in.
            </Text>
            <TouchableOpacity
              style={styles.checkRow}
              onPress={() => setRemember((current) => !current)}
              disabled={busy}
              hitSlop={8}
            >
              <View style={styles.checkBox}>
                {remember && <Ionicons name="checkmark" size={12} color={colors.accent} />}
              </View>
              <Text style={styles.checkText}>Do not ask this device for a code again today.</Text>
            </TouchableOpacity>
          </View>
        )}

        {!!error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.button, busy ? styles.buttonBusy : (!canSubmit && styles.buttonDisabled)]}
          onPress={handleSubmit}
          disabled={busy || !canSubmit}
        >
          {busy ? (
            <Text style={styles.buttonBusyText}>Signing in…</Text>
          ) : (
            <Text style={[styles.buttonText, !canSubmit && styles.buttonDisabledText]}>
              {waitingForCode ? "Enter code" : "Sign in"}
            </Text>
          )}
        </TouchableOpacity>

        <Text style={styles.note}>
          Broker credentials are connected separately after sign-in. Never enter your broker password here.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
