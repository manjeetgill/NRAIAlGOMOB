/**
 * Biometric unlock
 *
 * The second and later opens of the same day land here instead of the password screen: one tap, one
 * finger, and the session that password earned gets attached to the API client. Nothing is trusted until
 * the server itself confirms the identity, so a stored session the server no longer honours sends the
 * trader back to the password rather than into an app full of empty panels.
 */

import React, { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/components/ThemeProvider";
import { hydrateCachedUser, verifySession } from "@/utils/apiClient";
import {
  authenticate,
  clearSession,
  markUnlocked,
  readBiometry,
  unlockPlan,
  type LockReason,
} from "@/utils/deviceUnlock";

const CANCELLED = "Unlock cancelled. The app is still locked.";
const NOT_RECOGNISED = "Fingerprint not recognised. Nothing was opened.";
const LOCKED_OUT = "Five failed {noun} lock the stored session on this phone. Signing in with password restores it.";
const PASSWORD_FOOTNOTE =
  "Your password is not stored on this phone. Only the sign-in session is, and it is deleted the moment the server refuses it.";

/** "2026-11-27T04:12:00.000Z" read as the exchange's clock, which is not the phone's. */
function istTime(millis: number): string {
  return new Date(millis).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function passwordHref(reason: LockReason): string {
  return reason ? `/login?reason=${reason}` : "/login";
}

export default function UnlockScreen() {
  const { resolvedTheme } = useTheme();
  const inFlight = useRef(false);
  const [account, setAccount] = useState<{ email: string; signedInAt: number } | null>(null);
  const [label, setLabel] = useState("fingerprint");
  const [message, setMessage] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking">("idle");
  const [spent, setSpent] = useState(false);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [plan, biometry] = await Promise.all([unlockPlan(), readBiometry()]);
      if (cancelled) return;
      // A missing session, a rolled-over day or a phone that cannot do biometrics belongs on the password
      // screen, which is told why so the request does not read as a failure.
      if (!plan.canUnlock || !plan.account) {
        router.replace(passwordHref(plan.reason));
        return;
      }
      setAccount({ email: plan.account.email, signedInAt: plan.account.signedInAt });
      setLabel(biometry.label);
      setResolved(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dark = resolvedTheme === "dark";
  const colors = dark
    ? { bg: "#0f172a", text: "#f1f5f9", muted: "#94a3b8", dim: "#64748b", accent: "#38bdf8",
        ring: "#1e293b", errorBorder: "rgba(239,68,68,0.45)", errorBg: "rgba(239,68,68,0.09)",
        errorText: "#fecaca", note: "#64748b", border: "#334155" }
    : { bg: "#f8fafc", text: "#0f172a", muted: "#475569", dim: "#64748b", accent: "#0284c7",
        ring: "#e2e8f0", errorBorder: "rgba(239,68,68,0.45)", errorBg: "rgba(239,68,68,0.06)",
        errorText: "#b91c1c", note: "#64748b", border: "#cbd5e1" };

  const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    content: { flexGrow: 1, justifyContent: "center", padding: 20, paddingBottom: 40 },
    brand: { fontSize: 24, fontWeight: "700", color: colors.text },
    sub: { fontSize: 15, color: colors.muted, marginTop: 2, marginBottom: 26 },
    ring: { width: 78, height: 78, borderRadius: 39, alignItems: "center", justifyContent: "center",
      backgroundColor: dark ? "#111c30" : "#eef2f7", borderWidth: 1, borderColor: colors.ring,
      alignSelf: "center", marginBottom: 18 },
    account: { fontSize: 13, color: colors.muted, textAlign: "center", marginBottom: 22, lineHeight: 19 },
    button: { height: 46, borderRadius: 8, backgroundColor: "#0284c7", alignItems: "center",
      justifyContent: "center" },
    buttonText: { fontSize: 16, fontWeight: "700", color: "#ffffff" },
    link: { marginTop: 14, alignItems: "center", paddingVertical: 6 },
    linkText: { fontSize: 14, fontWeight: "600", color: colors.accent },
    errorBox: { borderWidth: 1, borderColor: colors.errorBorder, backgroundColor: colors.errorBg,
      borderRadius: 8, paddingHorizontal: 11, paddingVertical: 9, marginTop: 16 },
    errorText: { fontSize: 13, color: colors.errorText },
    note: { fontSize: 12, color: colors.note, marginTop: 22, borderTopWidth: 1,
      borderTopColor: colors.border, paddingTop: 12, lineHeight: 17 },
  });

  const noun = label === "face" ? "face scans" : "fingerprints";

  async function handleUnlock() {
    if (inFlight.current || !account) return;
    inFlight.current = true;
    setPhase("checking");
    setMessage(null);

    const outcome = await authenticate(`Unlock MyAlgoDesk for ${account.email}`);
    if (!outcome.ok) {
      inFlight.current = false;
      setPhase("idle");
      if (outcome.why === "gone") {
        // No biometric left on the phone: replaying the stored session would be the only gate, so drop it.
        await clearSession();
        router.replace(passwordHref("no_biometry"));
        return;
      }
      if (outcome.why === "locked") {
        await clearSession();
        setSpent(true);
        setMessage(LOCKED_OUT.replace("{noun}", noun));
        return;
      }
      setMessage(outcome.why === "cancel" ? CANCELLED : NOT_RECOGNISED);
      return;
    }

    markUnlocked();
    const check = await verifySession();
    inFlight.current = false;
    setPhase("idle");
    if (check === "refused") {
      await clearSession();
      router.replace(passwordHref("expired"));
      return;
    }
    if (check === "unreachable") {
      // Same as an offline cold start today: open on the cached screens, claim nothing new.
      await hydrateCachedUser();
    }
    router.replace("/(tabs)/portfolio");
  }

  if (!resolved || !account) {
    return <View style={styles.root} />;
  }

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.brand}>MyAlgoDesk</Text>
      <Text style={styles.sub}>Unlock</Text>

      <View style={styles.ring}>
        <Ionicons
          name={label === "face" ? "scan-circle-outline" : "finger-print"}
          size={38}
          color={message ? colors.errorText : colors.accent}
        />
      </View>

      <Text style={styles.account}>
        {account.email} · signed in with password today at {istTime(account.signedInAt)} IST
      </Text>

      {!spent && (
        <TouchableOpacity style={styles.button} onPress={handleUnlock} disabled={phase === "checking"}>
          <Text style={styles.buttonText}>
            {phase === "checking" ? "Checking sign-in…" : message ? `Try ${label} again` : `Unlock with ${label}`}
          </Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.link} onPress={() => router.replace("/login")} disabled={phase === "checking"}>
        <Text style={styles.linkText}>Use password instead</Text>
      </TouchableOpacity>

      {!!message && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{message}</Text>
        </View>
      )}

      <Text style={styles.note}>
        {message && !spent ? LOCKED_OUT.replace("{noun}", noun) : PASSWORD_FOOTNOTE}
      </Text>
    </ScrollView>
  );
}
