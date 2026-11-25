import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * PR #2 review follow-up. A screen may slow its REST read only when the socket is feeding THAT screen,
 * and a hidden tab must not lose its cached book to the default 5-minute garbage collection.
 */
const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeSocket.instances.push(this); }
  send() {}
  close(code = 1006) { if (this.readyState !== 3) { this.readyState = 3; this.onclose?.({ code }); } }
  open() { this.readyState = 1; this.onopen?.(); }
  frame(value: unknown) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(value) }); }
}

const RELIANCE = "instrument:v1:NSE:EQ:RELIANCE:CASH";
const NIFTY = "instrument:v1:NSE:INDEX:NIFTY%2050:INDEX";
const wire = (id: string, price: number, fresh = true) =>
  ({ id, broker: "icici", accountId: "live", subscriptionId: `s-${id}`, price, exchangeTime: "2026-11-25T04:30:00Z", fresh });

async function liveSocket() {
  vi.resetModules();
  FakeSocket.instances = [];
  vi.stubEnv("NODE_ENV", "test");
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  const mod = await import("../../packages/shared/src/api/websocket.ts");
  mod.watchQuotes([RELIANCE, NIFTY], () => {});
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  return { ...mod, socket };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("quoteStreamCarries gates on the screen's own ids", () => {
  it("is false when one of two ids never ticked", async () => {
    const { quoteStreamCarries, socket } = await liveSocket();
    socket.frame({ mode: "snapshot", quotes: [wire(RELIANCE, 1400)] });
    expect(quoteStreamCarries([RELIANCE])).toBe(true);
    expect(quoteStreamCarries([RELIANCE, NIFTY])).toBe(false);
  });

  it("is false for no ids, null, or a tick the server did not call fresh", async () => {
    const { quoteStreamCarries, socket } = await liveSocket();
    socket.frame({ mode: "snapshot", quotes: [wire(RELIANCE, 1400), wire(NIFTY, 25000, false)] });
    expect(quoteStreamCarries([])).toBe(false);
    expect(quoteStreamCarries(null)).toBe(false);
    expect(quoteStreamCarries([NIFTY])).toBe(false);
  });

  it("keeps a quiet but streamed stock counted while the feed is alive, and drops all when the feed goes quiet", async () => {
    vi.useFakeTimers();
    const { quoteStreamCarries, socket } = await liveSocket();
    socket.frame({ mode: "snapshot", quotes: [wire(RELIANCE, 1400), wire(NIFTY, 25000)] });
    vi.advanceTimersByTime(25_000);
    socket.frame({ mode: "delta", quotes: [wire(NIFTY, 25010)] });
    vi.advanceTimersByTime(25_000);
    // RELIANCE has not moved for 50 s, but NIFTY ticked 25 s ago, so the socket is alive and still carries it.
    expect(quoteStreamCarries([RELIANCE, NIFTY])).toBe(true);
    vi.advanceTimersByTime(10_000);
    // Nothing fresh anywhere for 35 s: the feed may be frozen, so every screen reads REST again.
    expect(quoteStreamCarries([RELIANCE, NIFTY])).toBe(false);
  });

  it("forgets an id the server removed, and everything on a closed socket", async () => {
    const { quoteStreamCarries, socket } = await liveSocket();
    socket.frame({ mode: "snapshot", quotes: [wire(RELIANCE, 1400), wire(NIFTY, 25000)] });
    socket.frame({ mode: "delta", quotes: [], removed: [JSON.stringify(["icici", "live", `s-${NIFTY}`])] });
    expect(quoteStreamCarries([NIFTY])).toBe(false);
    expect(quoteStreamCarries([RELIANCE])).toBe(true);
    socket.close();
    expect(quoteStreamCarries([RELIANCE])).toBe(false);
  });
});

describe("hidden tabs keep their cached data", () => {
  it("overrides the 5-minute gcTime on every query that unsubscribes when its tab is hidden", () => {
    for (const p of ["apps/mobile/app/(tabs)/watchlist.tsx", "apps/mobile/app/(tabs)/orders.tsx", "apps/mobile/app/(tabs)/portfolio.tsx", "apps/mobile/app/(tabs)/option-chain.tsx"]) {
      const screen = read(p);
      const unsubscribing = screen.match(/subscribed: focused/g)?.length ?? 0;
      const kept = screen.match(/gcTime: (Infinity|30 \* 60 \* 1000)/g)?.length ?? 0;
      expect(unsubscribing, p).toBeGreaterThan(0);
      expect(kept, p).toBe(unsubscribing);
    }
  });
});
