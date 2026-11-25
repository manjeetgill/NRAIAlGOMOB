import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 25 Nov 2026 review: the account SSE sends {accounts: {...}, asOf} (raw display snapshot), not the
// /v1/broker-auth/icici/account body, so a frame written into the caches blanked Positions and Orders.
it("treats an account stream frame as a signal to re-read, never as the account body", () => {
  const hooks = readFileSync(resolve(__dirname, "../../packages/shared/src/api/hooks.ts"), "utf8");
  const stream = hooks.slice(hooks.indexOf("const useAccountStream"), hooks.indexOf("const accountPoll"));
  expect(stream).toContain("invalidateQueries({ queryKey: queryKeys.brokerAccount.icici() })");
  expect(stream).toContain("invalidateQueries({ queryKey: queryKeys.positions.open() })");
  expect(stream).not.toContain("setQueryData");
  expect(hooks).not.toMatch(/JSON\.parse\(raw\) as IciciAccountPayload/);
});
