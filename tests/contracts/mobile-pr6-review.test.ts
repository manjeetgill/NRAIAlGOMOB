import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

// The Trade press hands `row` and `onTrade` to the ticket; a memo that skipped on a few price fields kept
// the previous underlying's handler and the old bid/ask.
it("re-renders an option row whenever anything the Trade press uses changed", () => {
  const chain = read("apps/mobile/app/(tabs)/option-chain.tsx");
  for (const prop of ["row", "expiry", "styles", "onTrade"]) {
    expect(chain).toContain(`prev.${prop} === next.${prop}`);
  }
  expect(chain).toContain("useInstrumentTick(quote?.instrumentId)");
});

// An expired session must go to sign-in; only an unreachable server keeps the saved user.
it("never keeps a cached user after the server refused the session", () => {
  const client = read("apps/mobile/src/utils/apiClient.ts");
  expect(client).toContain("const refused = status === 401 || status === 403;");
  expect(client).toContain("const retained = refused ? false : await hydrateCachedUser();");
});

// Scanner cards are not a fixed height, so a fixed getItemLayout put scroll positions off by the gap.
it("does not claim a fixed scanner card height", () => {
  expect(read("apps/mobile/app/scanner.tsx")).not.toContain("getItemLayout");
});
