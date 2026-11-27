/**
 * Fingerprint unlock for the sign-in session.
 *
 * React Native keeps the session cookie in memory, so killing the app used to cost a fresh email, password
 * and authenticator code every single time. This module stores the proof of sign-in in the phone's secure
 * storage and releases it only after the platform's own biometric prompt passes — which is what lets the
 * trader type the password once a day and use a finger for the rest of it.
 *
 * Two limits are deliberate. The stored session is only offered again on the IST day it was earned, so the
 * password returns with the new trading day. And the biometric module is imported lazily inside a try/catch:
 * a phone whose build has no biometric code gets the password screen, never a red error.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { formatISTDate, keptCookiePairs } from "@nraialgo/shared/utils";

const SESSION_KEY = "nraialgo.unlock.session";
const ACCOUNT_KEY = "nraialgo.unlock.account";
const OPT_OUT_KEY = "nraialgo.unlock.opt_out";

/** The site's own cookies, and nothing a CDN or a third party may set along with them. */
const KEPT_COOKIES = ["__Host-nraialgo_python_session", "__Host-nraialgo_python_mfa"];

export type StoredAccount = { email: string; day: string; signedInAt: number };
export type Biometry = { available: boolean; label: string };
export type LockReason = "new_day" | "expired" | "no_biometry" | null;
export type UnlockPlan = { canUnlock: boolean; account: StoredAccount | null; reason: LockReason };

/** The finger or face has been accepted during this run, so requests may carry the stored session. */
let unlockedThisRun = false;
/** Armed for the length of one password sign-in, so its cookie is the one that gets stored. */
let captureArmed = false;
let planForThisRun: Promise<UnlockPlan> | null = null;

function today(): string {
  return formatISTDate(new Date());
}

/** Never throws: a build without the biometric module simply reports that this phone cannot unlock. */
export async function readBiometry(): Promise<Biometry> {
  try {
    const LocalAuthentication = await import("expo-local-authentication");
    const [hardware, enrolled, types] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync().catch(() => []),
    ]);
    // AuthenticationType.FACIAL_RECOGNITION. Naming it here rather than importing the enum keeps the whole
    // module behind the lazy import, so a build without it cannot throw at load time.
    const face = (types as number[]).includes(2);
    return {
      available: hardware === true && enrolled === true,
      label: face ? "face" : "fingerprint",
    };
  } catch {
    return { available: false, label: "fingerprint" };
  }
}

async function readStoredSession(): Promise<string[] | null> {
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") && parsed.length
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}

export async function readAccount(): Promise<StoredAccount | null> {
  try {
    const raw = await SecureStore.getItemAsync(ACCOUNT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as StoredAccount).email === "string") {
      return parsed as StoredAccount;
    }
  } catch {
    // A record that cannot be read is only a missing prefill, not a reason to fail the screen.
  }
  return null;
}

/**
 * What to do on this cold start. The stored session is dropped rather than kept when the day has turned or
 * the phone can no longer do biometrics, so neither can quietly extend a sign-in past its intended life.
 */
export async function unlockPlan(): Promise<UnlockPlan> {
  if (planForThisRun) return planForThisRun;
  planForThisRun = (async () => {
    const [session, account, biometry, optedOut] = await Promise.all([
      readStoredSession(),
      readAccount(),
      readBiometry(),
      AsyncStorage.getItem(OPT_OUT_KEY).then((value) => value === "1").catch(() => false),
    ]);
    if (!session || !account) return { canUnlock: false, account, reason: null };
    if (account.day !== today()) {
      await clearSession();
      return { canUnlock: false, account, reason: "new_day" };
    }
    if (optedOut) return { canUnlock: false, account, reason: null };
    if (!biometry.available) {
      await clearSession();
      return { canUnlock: false, account, reason: "no_biometry" };
    }
    return { canUnlock: true, account, reason: null };
  })();
  return planForThisRun;
}

export function markUnlocked(): void {
  unlockedThisRun = true;
}

/** Arm the capture for one password sign-in; the cookie it returns is the one worth keeping. */
export function armCookieCapture(): void {
  captureArmed = true;
}

export function disarmCookieCapture(): void {
  captureArmed = false;
}

/** Called by the API client for every response that carries cookies. */
export async function storeCookies(values: string[]): Promise<void> {
  if (!captureArmed && !unlockedThisRun) return;
  const pairs = keptCookiePairs(values, KEPT_COOKIES);
  if (!pairs.length) return;
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(pairs)).catch(() => {});
}

/** Called by the API client before every request. Nothing is replayed until a biometric prompt has passed. */
export async function cookieHeader(): Promise<string | null> {
  if (!unlockedThisRun) return null;
  const pairs = await readStoredSession();
  return pairs?.length ? pairs.join("; ") : null;
}

/** Remember whose phone this is, so the next sign-in asks for a password but not for an email. */
export async function saveAccount(email: string): Promise<void> {
  const account: StoredAccount = { email, day: today(), signedInAt: Date.now() };
  await SecureStore.setItemAsync(ACCOUNT_KEY, JSON.stringify(account)).catch(() => {});
  planForThisRun = null;
}

/** Drop the stored session but keep the email, which is what makes the next sign-in one field shorter. */
export async function clearSession(): Promise<void> {
  unlockedThisRun = false;
  captureArmed = false;
  await SecureStore.deleteItemAsync(SESSION_KEY).catch(() => {});
  planForThisRun = null;
}

/** Sign-out is final: no session and no account record, so nothing is prefilled for the next person. */
export async function forgetDeviceUnlock(): Promise<void> {
  await clearSession();
  await SecureStore.deleteItemAsync(ACCOUNT_KEY).catch(() => {});
}

/** What the password screen's switch should show on this run: the last choice the trader made. */
export async function readOptOut(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(OPT_OUT_KEY)) === "1";
  } catch {
    return false;
  }
}

/** Turning it off is remembered, and drops the session that turning it on would have stored. */
export async function setOptOut(value: boolean): Promise<void> {
  if (value) {
    await AsyncStorage.setItem(OPT_OUT_KEY, "1").catch(() => {});
    await clearSession();
  } else {
    await AsyncStorage.removeItem(OPT_OUT_KEY).catch(() => {});
    planForThisRun = null;
  }
}

/**
 * Ask the platform for the finger or face. `cancel` is the trader stepping back from the prompt and is not a
 * failure worth alarming them about; `gone` means the phone no longer has a biometric to ask for, which ends
 * the stored session rather than offering a button that can never pass.
 */
export async function authenticate(
  reason: string,
): Promise<{ ok: boolean; why: "cancel" | "failed" | "locked" | "gone" | null }> {
  try {
    const LocalAuthentication = await import("expo-local-authentication");
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: "Use password",
    });
    if (result.success) return { ok: true, why: null };
    // The app is built with `strict: false`, which leaves TS unable to narrow the success/failure union, so
    // the failure code is read through its shape rather than trusted to exist.
    const code = String((result as { error?: unknown }).error ?? "");
    switch (code) {
      case "user_cancel":
      case "system_cancel":
      case "app_cancel":
      case "user_fallback":
        return { ok: false, why: "cancel" };
      case "lockout":
      case "timeout":
      case "no_space":
      case "unable_to_process":
        return { ok: false, why: "locked" };
      case "not_enrolled":
      case "passcode_not_set":
      case "not_available":
        return { ok: false, why: "gone" };
      default:
        return { ok: false, why: "failed" };
    }
  } catch {
    return { ok: false, why: "gone" };
  }
}
