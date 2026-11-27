import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { keptCookiePairs, splitSetCookies } from "../../packages/shared/src/utils/index.ts";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const unlock = read("apps/mobile/src/utils/deviceUnlock.ts");
const client = read("packages/shared/src/api/client.ts");
const apiClient = read("apps/mobile/src/utils/apiClient.ts");
const unlockScreen = read("apps/mobile/app/unlock.tsx");
const loginScreen = read("apps/mobile/app/login.tsx");
const entry = read("apps/mobile/app/index.tsx");
const layout = read("apps/mobile/app/_layout.tsx");
const links = read("apps/mobile/src/utils/deepLinking.ts");
const more = read("apps/mobile/app/(tabs)/more.tsx");

const SESSION = "__Host-nraialgo_python_session";
const MFA = "__Host-nraialgo_python_mfa";
const KEPT = [SESSION, MFA];

/**
 * Password once a day, fingerprint after that.
 *
 * Identity on myalgodesk.in is one host-only session cookie, and React Native keeps that cookie in memory,
 * so killing the app used to cost a fresh password and authenticator code every time. The fix stores the
 * cookie in Keystore-backed secure storage and replays it only after the platform's own biometric prompt
 * passes — which makes the stored string worthless without the finger, and the finger worthless without a
 * session the server still honours. These tests hold both halves: which cookies may be replayed, and which
 * screen is allowed to ask for them.
 */

describe("Only the site's own session is worth replaying", () => {
  it("keeps the host session cookie and drops everything else", () => {
    const header = `${SESSION}=abc123; Path=/; HttpOnly, _ga=GA1.1.x; Path=/, ${MFA}=mfa9; Max-Age=30`;
    expect(keptCookiePairs([header], KEPT)).toEqual([`${SESSION}=abc123`, `${MFA}=mfa9`]);
  });

  it("splits a comma-joined set-cookie list on the cookie boundary, not the expiry comma", () => {
    const joined =
      `${SESSION}=a; Expires=Thu, 27 Nov 2026 04:00:00 GMT; Path=/, ${MFA}=b; Path=/`;
    const parts = splitSetCookies([joined]);
    expect(parts).toHaveLength(2);
    expect(parts[0].startsWith(`${SESSION}=a;`)).toBe(true);
    // The naive split the comment forbids would leave "27 Nov 2026 04:00:00 GMT; Path=/" as its own entry.
    expect(parts.every((part) => /=/.test(part) && !part.startsWith("27"))).toBe(true);
    expect(keptCookiePairs([joined], KEPT)).toEqual([`${SESSION}=a`, `${MFA}=b`]);
  });

  it("treats an emptied session cookie as a sign-out and keeps nothing", () => {
    expect(keptCookiePairs([`${SESSION}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`], KEPT)).toEqual([]);
    expect(keptCookiePairs([`${MFA}=b; Path=/`, `${SESSION}=`], KEPT)).toEqual([]);
  });
});

describe("The stored session is released only by the phone", () => {
  it("imports the biometric module lazily so a build without it cannot red-screen the app", () => {
    expect(unlock).toContain('await import("expo-local-authentication")');
    expect(unlock).not.toMatch(/^import \* as LocalAuthentication/m);
  });

  it("keeps the session alive only for the IST day it was earned", () => {
    expect(unlock).toMatch(/formatISTDate/);
    expect(unlock).toMatch(/account\.day !== today\(\)/);
    expect(unlock).toContain("await clearSession()");
  });

  it("sends the stored cookie only after a biometric has passed in this run", () => {
    expect(unlock).toMatch(/export async function cookieHeader\(\)[\s\S]*?if \(!unlockedThisRun\) return null/);
    expect(unlock).toMatch(/export async function storeCookies\([\s\S]*?if \(!captureArmed && !unlockedThisRun\) return/);
  });

  it("never stores the password, only the session it earned", () => {
    const writes = unlock.match(/SecureStore\.setItemAsync\((\w+)/g) ?? [];
    expect(writes.sort()).toEqual(["SecureStore.setItemAsync(ACCOUNT_KEY", "SecureStore.setItemAsync(SESSION_KEY"]);
    expect(unlock).toContain("export async function saveAccount(email: string)");
  });
});

describe("The API client carries the session the phone released", () => {
  it("asks the host app for the cookie header and hands back every Set-Cookie", () => {
    expect(client).toContain("getCookieHeader?: () => Promise<string | null>");
    expect(client).toContain("storeCookies?: (values: string[]) => Promise<void>");
    expect(client).toMatch(/\.\.\.\(cookieHeader \? \{ Cookie: cookieHeader \} : \{\}\)/);
    expect(client).toMatch(/config\.storeCookies\(cookies\)/);
  });

  it("is wired on the phone and left alone on web, where the browser owns cookies", () => {
    expect(apiClient).toContain("getCookieHeader: cookieHeader");
    expect(apiClient).toContain("storeCookies,");
    expect(client).not.toMatch(/document\.cookie/);
  });

  it("separates a server refusal from an unreachable server, because only one ends the session", () => {
    expect(apiClient).toMatch(/export type SessionCheck = "ok" \| "refused" \| "unreachable"/);
    expect(apiClient).toMatch(/status === 401 \|\| status === 403 \? "refused" : "unreachable"/);
    // The cold-boot probe keeps its own rules: a refusal wipes the saved account, a timeout does not.
    expect(apiClient).toContain("const refused = status === 401 || status === 403");
  });
});

describe("Cold start asks the finger before the password", () => {
  it("routes a phone holding today's session to the unlock screen", () => {
    expect(entry).toContain("unlockPlan()");
    expect(entry).toMatch(/if \(plan\.canUnlock\) return <Redirect href="\/unlock" \/>/);
    // The hydrated user record is what this phone last believed, not proof of a session, so it must not
    // outrank the unlock gate.
    expect(entry.indexOf("if (plan.canUnlock)")).toBeLessThan(entry.indexOf("isAuthenticated ?"));
  });

  it("carries the reason a stored session stopped working onto the password screen", () => {
    // Without this the trader reaches a bare password form on the morning after, and the sentence that
    // explains why the finger is gone never renders.
    expect(entry).toMatch(/if \(plan\.reason\) return <Redirect href=\{`\/login\?reason=\$\{plan\.reason\}`\} \/>/);
    expect(entry.indexOf("if (plan.reason)")).toBeLessThan(entry.indexOf("isAuthenticated ?"));
  });

  it("does not probe the server while an unlock is pending", () => {
    expect(layout).toMatch(/unlockPlan\(\)/);
    expect(layout).toMatch(/plan\.canUnlock \? null : initializeApiClient\(\)/);
    expect(layout).toMatch(/pathname === "\/login" \|\| pathname === "\/unlock"/);
  });
});

describe("The unlock screen says the same thing the design agreed", () => {
  const strings = [
    "Unlock",
    "Unlock with ${label}",
    "signed in with password today at",
    "Use password instead",
    "Fingerprint not recognised. Nothing was opened.",
    "Unlock cancelled. The app is still locked.",
    "Five failed",
    "Your password is not stored on this phone. Only the sign-in session is, and it is deleted the moment the server refuses it.",
  ];

  it.each(strings)("shows %s", (text) => {
    expect(unlockScreen).toContain(text);
  });

  it("re-checks the session with the server before opening the app", () => {
    expect(unlockScreen).toContain("markUnlocked()");
    expect(unlockScreen).toContain("await verifySession()");
    expect(unlockScreen).toContain('router.replace(passwordHref("expired"))');
    expect(unlockScreen).toMatch(/if \(check === "refused"\) \{\s*\n\s*await clearSession\(\)/);
  });

  it("never leaves the trader without a way in", () => {
    // The retry button disappears once the session is spent; the password link sits beside it, ungated.
    expect(unlockScreen).toContain("{!spent && (");
    const linkStart = unlockScreen.indexOf('<TouchableOpacity style={styles.link}');
    expect(unlockScreen.slice(linkStart - 40, linkStart)).toMatch(/\n {6}$/);
    expect(unlockScreen).toContain("Use password instead");
  });
});

describe("The password screen hands the day over to the finger", () => {
  it("captures only the cookie this sign-in earns", () => {
    expect(loginScreen).toMatch(/armCookieCapture\(\);[\s\S]*?finally \{\s*\n\s*disarmCookieCapture\(\)/);
  });

  it("remembers the account for the unlock screen after the server proves the session", () => {
    expect(loginScreen).toMatch(/markUnlocked\(\);\s*\n\s*await saveAccount\(email\.trim\(\)\)/);
  });

  it("prefills the email and explains why the password came back", () => {
    expect(loginScreen).toContain("readAccount()");
    for (const reason of [
      "It is a new day, so the password is asked for again. Fingerprint unlock comes back after this sign-in.",
      "This phone's sign-in expired. Enter your password to continue.",
      "This phone has no fingerprint or face set up, so the password is asked for each time.",
      "Use fingerprint on this phone until tomorrow",
    ]) {
      expect(loginScreen.replace(/\{biometryLabel\}/g, "fingerprint")).toContain(reason);
    }
  });

  it("remembers a trader who turned the finger down", () => {
    expect(loginScreen).toContain("readOptOut()");
    expect(loginScreen).toContain("await setOptOut(!keepBiometry)");
  });

  it("renders the sentence the route carries, not just the one it was written for", () => {
    expect(loginScreen).toMatch(/const \{ reason \} = useLocalSearchParams/);
    expect(loginScreen).toMatch(/\{!!reason && !!REASONS\[reason\] && <Text style=\{styles\.reason\}>\{REASONS\[reason\]\}<\/Text>/);
  });

  it("keeps the reason through a deep link, which used to drop every query on /login", () => {
    expect(links).toContain('"/login": (params) => `/login${params.reason ? `?reason=${encodeURIComponent(params.reason)}` : ""}`');
  });
});

describe("Sign-out ends the fingerprint's authority", () => {
  it("forgets the session and the account before returning to the password screen", () => {
    expect(more).toMatch(/await forgetDeviceUnlock\(\);\s*\n\s*router\.replace\("\/login"\)/);
  });
});
