import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { readFailure } from "../../packages/shared/src/api/hooks.ts";

/**
 * The emulator sweep over main left three screens that could not explain themselves. Two of the failures
 * were the same two mistakes, repeated per screen: prod writes its refusal as a finished sentence
 * ("Sign in required.", "Market snapshot is unavailable. Retry shortly.") and the template bolted another
 * full stop onto it, and every one of them treated a 401 as if the trader had typed a wrong password when
 * what actually happens is the session cookie aging out under a screen left open. `readFailure` is the one
 * place that decides both, so a screen cannot get either wrong on its own.
 */

/** How the mobile client reports a refused read: prod's `{"message": ...}` body, status carried on the Error. */
function refusal(status: number, message: string) {
  const error = new Error(message) as Error & { status: number; details: unknown };
  error.status = status;
  error.details = { message };
  return error;
}

it("keeps prod's own words for a refusal that is not about signing in", () => {
  const read = readFailure(
    refusal(503, "Market snapshot is unavailable. Retry shortly."),
    "The broker has not priced this stock yet.",
    "the price of this stock",
  );
  expect(read.needsSignIn).toBe(false);
  expect(read.text).toBe("Market snapshot is unavailable. Retry shortly.");
});

it("names an aged-out session in words the trader can act on", () => {
  const read = readFailure(refusal(401, "Sign in required."), "The option chain could not be read.", "the option chain");
  expect(read.needsSignIn).toBe(true);
  expect(read.text).toBe("Your sign-in timed out, so the server refused the option chain.");
  expect(read.text).not.toContain("Sign in required");
});

/** The exact string off the screen: "Chain read failed: Sign in required.. Pick another symbol to build on." */
it("closes a sentence once, however the caller continues it", () => {
  const line = `${readFailure(refusal(401, "Sign in required."), "The option chain could not be read.", "the option chain").text} Pick another symbol to build on.`;
  expect(line).not.toMatch(/\.\./);
  expect(line.endsWith(".")).toBe(true);
});

it("speaks for itself when prod sent only a status line", () => {
  const read = readFailure(refusal(503, "HTTP 503: Service Unavailable"), "The stored scans could not be read.", "the stored scans");
  expect(read.needsSignIn).toBe(false);
  expect(read.text).toBe("The stored scans could not be read.");
});

// The screens are where these sentences either reach the trader or get replaced by a spinner.
const scanner = readFileSync(resolve("apps/mobile/app/scanner.tsx"), "utf8");
const builder = readFileSync(resolve("apps/mobile/app/spread-builder.tsx"), "utf8");

/**
 * A cold scanner read takes 10-15 s and showed nothing but a spinner; a refused one said
 * "Failed to load scanner data" and threw away both the server's reason and the rows the earlier read
 * had already delivered.
 */
it("tells the trader what the scanner is waiting for, and why when it fails", () => {
  expect(scanner).toContain('readFailure(error, "The stored scans could not be read.", "the stored scans")');
  expect(scanner).toContain("Reading the stored scans. The first load takes a while.");
  expect(scanner).toContain("if (isLoading && !failure)");
  // The refusal only replaces the screen while it holds no rows, and stays tappable when it does.
  expect(scanner).toContain("if (failure && !data)");
  expect(scanner).toContain('router.replace("/login")');
  expect(scanner).toContain("refreshing={isFetching}");
  expect(scanner).toContain('"The scan carried no session date"');
});

it("reads the ladder refusal from one sentence and points at the way back", () => {
  expect(builder).toContain('readFailure(chainError, "The option chain could not be read.", "the option chain")');
  expect(builder).toContain("${chainFailure.text} Pick another symbol to build on.");
  expect(builder).toContain('router.replace("/login")');
  // The picker's own read is described as itself, so two refusals on one screen do not print one twice.
  expect(builder).toContain('readFailure(catalogueError, "The list of underlyings could not be read.", "the list of underlyings")');
  expect(builder).not.toContain("Chain read failed");
  // Nothing on this screen may put the server's raw sentence on screen with a period of its own.
  expect(builder).not.toContain("chartFailureReason(");
});
