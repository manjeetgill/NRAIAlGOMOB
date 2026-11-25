import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { queryKeys, rereadAccountOnFrame, throttleReread } from "../../packages/shared/src/api/hooks.ts";

const hooks = readFileSync(resolve(__dirname, "../../packages/shared/src/api/hooks.ts"), "utf8");

afterEach(() => vi.useRealTimers());

// 25 Nov 2026 review: the account SSE sends {accounts: {...}, asOf} (raw display snapshot), not the
// /v1/broker-auth/icici/account body, so a frame written into the caches blanked Positions and Orders.
it("treats an account stream frame as a signal to re-read, never as the account body", () => {
  const stream = hooks.slice(hooks.indexOf("const useAccountStream"), hooks.indexOf("const accountPoll"));
  expect(stream).toContain("() => rereadAccountOnFrame(queryClient)");
  expect(stream).not.toContain("setQueryData");
  expect(hooks).not.toMatch(/JSON\.parse\(raw\) as IciciAccountPayload/);
});

/** Which keys a frame re-reads (refetchType active) and which it only marks stale. */
function frameOn(accountShown: boolean) {
  const qc = new QueryClient();
  const off = [new QueryObserver(qc, { queryKey: queryKeys.positions.open(), queryFn: async () => [], enabled: false }).subscribe(() => {})];
  if (accountShown) off.push(new QueryObserver(qc, { queryKey: queryKeys.brokerAccount.icici(), queryFn: async () => ({}), enabled: false }).subscribe(() => {}));
  const spy = vi.spyOn(qc, "invalidateQueries");
  rereadAccountOnFrame(qc);
  off.forEach((f) => f());
  const reads = spy.mock.calls.filter(([f]) => f?.refetchType !== "none").map(([f]) => f?.queryKey);
  const marked = spy.mock.calls.filter(([f]) => f?.refetchType === "none").map(([f]) => f?.queryKey);
  return { reads, marked };
}

it("costs one GET per frame when both screens are open: the account read, which seeds positions", () => {
  expect(frameOn(true)).toEqual({ reads: [queryKeys.brokerAccount.icici()], marked: [queryKeys.positions.open()] });
});

it("re-reads positions alone when no screen is showing the account body", () => {
  expect(frameOn(false)).toEqual({ reads: [queryKeys.positions.open()], marked: [queryKeys.brokerAccount.icici()] });
});

it("re-reads an order when the order stream names it by the server's client_id, throttled", () => {
  const start = hooks.indexOf("/v1/broker-auth/order/stream");
  const stream = hooks.slice(start, hooks.indexOf("return useQuery", start));
  expect(stream).toContain("i.client_id ?? i.clientId");
  expect(stream).toContain("if (named) reread.request();");
  expect(stream).not.toContain("setQueryData");
});

it("holds a burst of order frames to one read at once and one trailing read per window", () => {
  vi.useFakeTimers();
  let reads = 0;
  const reread = throttleReread(() => { reads += 1; }, 2000);
  reread.request();
  expect(reads).toBe(1);
  for (let i = 0; i < 5; i += 1) { vi.advanceTimersByTime(200); reread.request(); }
  expect(reads).toBe(1);
  vi.advanceTimersByTime(1000);
  expect(reads).toBe(2); // the final state of the burst is still read
  vi.advanceTimersByTime(5000);
  expect(reads).toBe(2);
  reread.request();
  reread.cancel();
  expect(reads).toBe(3);
});
