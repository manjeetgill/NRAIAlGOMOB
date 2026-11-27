/**
 * What the server knows about this account's sign-in safety, and the words the phone prints for it.
 *
 * `GET /v1/auth/mfa` is one of the few routes prod leaves open to a session that has NOT completed the
 * two-factor code step, so this read is what tells a trader why every other tab came back with a 403. Two of
 * its four fields are about the account (`enabled`, `recoveryCodesRemaining`) and two are about this device's
 * session or the deployment (`verificationRequired`, `emailVerificationRequired`), which is why they get
 * separate rows instead of one "secure / not secure" badge.
 *
 * Changing any of it stays on the web desk: enrolment needs the authenticator QR scanned and the recovery
 * codes shown once, and neither belongs in a screen that only reads.
 */

/** Prod's own answer, narrowed to the four fields the phone has a sentence for. */
export interface MfaStatus {
  enabled: boolean;
  verificationRequired: boolean;
  emailVerificationRequired: boolean;
  recoveryCodesRemaining: number;
}

/**
 * The body checked field by field.
 *
 * A screen that read a missing `enabled` as false would tell a trader two-factor is off when the server
 * simply answered with something else, so an unreadable body throws and the screen reports that it could not
 * read the account rather than guessing.
 */
export function readMfaStatus(value: unknown): MfaStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid two-factor status");
  const body = value as Record<string, unknown>;
  const flag = (key: "enabled" | "verificationRequired" | "emailVerificationRequired"): boolean => {
    const answer = body[key];
    if (typeof answer !== "boolean") throw new Error(`Invalid two-factor status: ${key}`);
    return answer;
  };
  // An account that never issued codes has no array, and cardinality(NULL) reaches prod as null, not 0.
  const count = body.recoveryCodesRemaining;
  const remaining = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return {
    enabled: flag("enabled"),
    verificationRequired: flag("verificationRequired"),
    emailVerificationRequired: flag("emailVerificationRequired"),
    recoveryCodesRemaining: remaining,
  };
}

export interface SecurityLine {
  label: string;
  /** The fact, in the trader's words. Never a dash and never "Unavailable". */
  value: string;
  /** Why it matters and where the fix lives. */
  detail: string;
  /**
   * Whether this line should be coloured at all. The email-confirmation policy belongs to the deployment, so
   * painting it green or red would be the app editorialising about a rule it did not choose.
   */
  tone: "good" | "warn" | "bad" | "neutral";
}

/**
 * Four rows, each saying which of the two questions it answers: the account's, or this session's.
 *
 * `verificationRequired` is read off the session, not the account, so a row that called it "two-factor is on"
 * would be wrong in both directions for an enrolled trader signing in on a new phone.
 */
export function securityLines(status: MfaStatus, host: string): SecurityLine[] {
  const codes = status.recoveryCodesRemaining;
  return [
    {
      label: "Two-factor",
      value: status.enabled ? "Set up on this account" : "Not set up",
      detail: status.enabled
        ? "The server holds an authenticator secret for this account."
        : `Set it up on ${host}. Without it, a leaked password is the only thing between a stranger and this account's orders.`,
      tone: status.enabled ? "good" : "bad",
    },
    {
      label: "This sign-in",
      value: status.verificationRequired ? "Waiting for a code" : "Code already given",
      detail: status.verificationRequired
        ? `The server will not answer the trading routes for this session until a code is entered; it replies "Set up two-factor authentication in Account & security first." Complete the code step on ${host} or at the next sign-in.`
        : "This session passed the code step, so the tabs can read the broker through it.",
      tone: status.verificationRequired ? "warn" : "good",
    },
    {
      label: "Recovery codes",
      value: codes > 0 ? `${codes} left on the server` : "None on the server",
      detail: codes > 0
        ? "Each code signs the account in once, without the authenticator."
        : status.enabled
          ? `Generate a new set on ${host}. With no codes left and the authenticator unavailable, the account cannot be signed in.`
          : `Codes are issued when two-factor is set up on ${host}.`,
      tone: codes > 0 ? "good" : status.enabled ? "warn" : "neutral",
    },
    {
      label: "Email confirmation",
      value: status.emailVerificationRequired ? "Required to change two-factor" : "Not required",
      detail: status.emailVerificationRequired
        ? "Changing two-factor on this account needs a code emailed to the sign-in address first."
        : "This deployment lets two-factor settings change without an emailed code.",
      tone: "neutral",
    },
  ];
}

export const SIGN_OUT_ALL_TITLE = "Sign out of all devices";

/**
 * The row a shared phone needs. `POST /v1/auth/logout-all` deletes every session row for the account and
 * revokes the registered devices, so unlike signing out here it cannot be taken back by signing in again -
 * the trader has to walk every device through sign-in.
 */
export const SIGN_OUT_ALL_WARNING =
  "Every phone and browser signed in to this account loses it the moment you do this, including this one. The server deletes the sessions rather than pausing them, so each device has to sign in again.";
