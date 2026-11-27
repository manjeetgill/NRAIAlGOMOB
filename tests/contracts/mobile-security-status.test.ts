import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readMfaStatus,
  securityLines,
  SIGN_OUT_ALL_TITLE,
  SIGN_OUT_ALL_WARNING,
  type MfaStatus,
} from "../../packages/shared/src/api/security.ts";

/**
 * `/v1/auth/mfa` is one of the few prod routes a session that still owes a two-factor code may call, which is
 * what makes it the answer to "why did every tab 403 on me". Four fields, two of them about the account and
 * two about this session or the deployment — folded into one badge they would lie in both directions, so each
 * keeps its own row here.
 */

const HOST = "myalgodesk.in";
const status = (over: Partial<MfaStatus> = {}): MfaStatus => ({
  enabled: false,
  verificationRequired: false,
  emailVerificationRequired: true,
  recoveryCodesRemaining: 0,
  ...over,
});

const line = (label: string, s: MfaStatus) => {
  const found = securityLines(s, HOST).find(row => row.label === label);
  if (!found) throw new Error(`no ${label} row`);
  return found;
};

describe("The body is read or refused, never guessed", () => {
  it("accepts prod's own shape", () => {
    expect(readMfaStatus({
      enabled: true,
      verificationRequired: false,
      emailVerificationRequired: true,
      recoveryCodesRemaining: 8,
    })).toEqual({
      enabled: true,
      verificationRequired: false,
      emailVerificationRequired: true,
      recoveryCodesRemaining: 8,
    });
  });

  it("refuses a body whose flags it cannot read", () => {
    // A missing `enabled` read as false would tell a trader two-factor is off when the server said something else.
    expect(() => readMfaStatus({})).toThrow(/enabled/);
    expect(() => readMfaStatus({ enabled: "yes", verificationRequired: false, emailVerificationRequired: false })).toThrow(/enabled/);
    expect(() => readMfaStatus(null)).toThrow("Invalid two-factor status");
    expect(() => readMfaStatus([])).toThrow("Invalid two-factor status");
    expect(() => readMfaStatus({ enabled: true, verificationRequired: null, emailVerificationRequired: false })).toThrow(/verificationRequired/);
  });

  it("reads a null code count as none, because cardinality(NULL) is not zero", () => {
    // An account that never issued codes has no array on the row, and prod serializes that as null.
    expect(readMfaStatus({
      enabled: true, verificationRequired: false, emailVerificationRequired: false, recoveryCodesRemaining: null,
    }).recoveryCodesRemaining).toBe(0);
  });

  it("keeps a count whole and non-negative", () => {
    const read = (recoveryCodesRemaining: unknown) => readMfaStatus({
      enabled: true, verificationRequired: false, emailVerificationRequired: false, recoveryCodesRemaining,
    }).recoveryCodesRemaining;
    expect(read(7.9)).toBe(7);
    expect(read(-2)).toBe(0);
    expect(read("lots")).toBe(0);
  });
});

describe("The account's protection and this session's code step stay separate", () => {
  it("says the account is unprotected when it is", () => {
    const row = line("Two-factor", status());
    expect(row.value).toBe("Not set up");
    expect(row.tone).toBe("bad");
    expect(row.detail).toContain(HOST);
  });

  it("tells an enrolled trader on a new phone that the account is fine and the session is not", () => {
    // The case a single "secure / not secure" badge gets wrong in both directions.
    const s = status({ enabled: true, verificationRequired: true, recoveryCodesRemaining: 5 });
    expect(line("Two-factor", s).value).toBe("Set up on this account");
    expect(line("Two-factor", s).tone).toBe("good");
    expect(line("This sign-in", s).value).toBe("Waiting for a code");
    expect(line("This sign-in", s).tone).toBe("warn");
    expect(line("This sign-in", s).detail).toContain("Set up two-factor authentication in Account & security first.");
  });

  it("says a session that has used its code can trade", () => {
    const s = status({ enabled: true, verificationRequired: false });
    expect(line("This sign-in", s).value).toBe("Code already given");
    expect(line("This sign-in", s).tone).toBe("good");
  });
});

describe("Recovery codes and the deployment's email rule", () => {
  it("counts the codes the server still holds", () => {
    const s = status({ enabled: true, recoveryCodesRemaining: 3 });
    expect(line("Recovery codes", s).value).toBe("3 left on the server");
    expect(line("Recovery codes", s).tone).toBe("good");
  });

  it("warns when two-factor is on with nothing left to sign in with", () => {
    const s = status({ enabled: true, recoveryCodesRemaining: 0 });
    const row = line("Recovery codes", s);
    expect(row.value).toBe("None on the server");
    expect(row.tone).toBe("warn");
    expect(row.detail).toContain(HOST);
  });

  it("does not call missing codes a warning before two-factor exists", () => {
    expect(line("Recovery codes", status()).tone).toBe("neutral");
  });

  it("states the email rule without grading it", () => {
    // The flag belongs to the deployment; painting it good or bad would be the app editorialising.
    for (const required of [true, false]) {
      const row = line("Email confirmation", status({ emailVerificationRequired: required }));
      expect(row.tone).toBe("neutral");
      expect(row.value).toBe(required ? "Required to change two-factor" : "Not required");
    }
  });

  it("gives every row a sentence rather than a dash", () => {
    for (const s of [status(), status({ enabled: true, verificationRequired: true, recoveryCodesRemaining: 9 })]) {
      const rows = securityLines(s, HOST);
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.value.length).toBeGreaterThan(3);
        expect(row.detail.length).toBeGreaterThan(20);
        expect(row.detail).not.toContain("Unavailable");
        expect(row.value).not.toMatch(/^—$|^-$|^\s*$/);
      }
    }
  });
});

describe("Signing out everywhere says what it costs", () => {
  it("names the phone in the trader's hand", () => {
    // The route deletes every session row and revokes the devices; signing in again does not undo it.
    expect(SIGN_OUT_ALL_WARNING).toContain("including this one");
    expect(SIGN_OUT_ALL_WARNING).toContain("deletes the sessions");
    expect(SIGN_OUT_ALL_TITLE).toBe("Sign out of all devices");
  });
});

describe("The app reads the routes prod registers", () => {
  const hooks = readFileSync(resolve("packages/shared/src/api/hooks.ts"), "utf8");
  const screen = readFileSync(resolve("apps/mobile/app/security.tsx"), "utf8");
  const more = readFileSync(resolve("apps/mobile/app/(tabs)/more.tsx"), "utf8");

  it("reads the status route the backend actually serves", () => {
    expect(hooks).toContain('client.get("/v1/auth/mfa")');
    expect(hooks).toContain("readMfaStatus(");
  });

  it("clears the cache when every device is signed out", () => {
    const block = hooks.slice(hooks.indexOf("const useLogoutAll"), hooks.indexOf("// ===== BASKETS ====="));
    expect(block).toContain('"/v1/auth/logout-all"');
    expect(block).toContain("qc.clear()");
    // Same guard as useLogout: a caller's own onSuccess extends the clear, it cannot replace it.
    expect(block).toContain("const { onSuccess, ...rest } = options ?? {};");
  });

  it("hands both hooks to the screens", () => {
    expect(hooks).toMatch(/\n\s*useMfa,\n/);
    expect(hooks).toMatch(/\n\s*useLogoutAll,\n/);
    expect(screen).toContain("useMfa()");
    expect(screen).toContain("useLogoutAll()");
  });

  it("signs this phone out only after the server agrees", () => {
    // onSettled would clear the phone and jump to the sign-in screen after a failed call, hiding the failure.
    expect(screen).toContain("onSuccess: () => {");
    expect(screen).not.toContain("onSettled");
    expect(screen).toContain("This phone stayed signed in.");
  });

  it("writes nothing else", () => {
    expect(screen).not.toMatch(/client\.(post|put|patch|delete)/);
    expect(screen).not.toContain("useMutation");
    expect(screen).not.toMatch(/broker-credentials|broker-auth/);
  });

  it("keeps the enrolment job where the phone cannot fake it", () => {
    expect(screen).toContain("authenticator QR");
    expect(screen).not.toMatch(/enroll|\/mfa\/confirm/);
  });

  it("lets the trader ask the server again without leaving the screen", () => {
    // The read is 60s stale by design, so the way to see a code step completed on the web desk is a pull.
    expect(screen).toContain("<RefreshControl");
    expect(screen).toContain("onRefresh={() => void refetch()}");
  });

  it("opens from a real row on More", () => {
    expect(existsSync(resolve("apps/mobile/app/security.tsx"))).toBe(true);
    expect(more).toContain('router.push("/security")');
    const chevrons = (more.match(/chevron-forward-outline/g) ?? []).length;
    const pushes = (more.match(/router\.push\(/g) ?? []).length;
    expect(chevrons).toBe(pushes);
  });
});
