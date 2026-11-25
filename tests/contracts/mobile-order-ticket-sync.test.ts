import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createTradingStore } from "../../packages/shared/src/stores/index.ts";

const hook = readFileSync(resolve(__dirname, "../../packages/shared/src/hooks/useOrderTicket.tsx"), "utf8");

it("syncs a ticket to the store in one direction only, while it is open", () => {
  const effect = hook.slice(hook.indexOf("// One direction only"), hook.indexOf("// Open order ticket with config"));
  expect(effect).toContain("if (!visible) return;");
  // The store is not a dependency, so a store change from another ticket never re-runs this one.
  expect(effect).toContain("}, [localState, visible, setOrderTicketBatch]);");
  expect(effect).not.toContain("storedTicket]");
});

it("writes every changed field in one store update", () => {
  const store = createTradingStore();
  let updates = 0;
  const off = store.subscribe(() => { updates += 1; });
  store.getState().setOrderTicketBatch({ quantity: 50, side: "SELL" });
  off();
  expect(updates).toBe(1);
  expect(store.getState().orderTicket).toMatchObject({ quantity: 50, side: "SELL" });
});
