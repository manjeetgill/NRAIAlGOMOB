import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Constants, deriveWsUrl } from "../../packages/shared/src/constants/index.ts";

/**
 * The one thing a price screen cannot check for itself: whether the stream under it is still carrying
 * prices. React Native reports a socket it suspended over a screen as healthy, and prod has held a stream
 * that said "icici: streaming" while publishing nothing for an hour (25 Nov 2026), so liveness here is the
 * client's own job — a quiet pipe is recycled, and a pipe that ran out of retries gets them back when the
 * app returns to the foreground or the network comes back with it.
 *
 * The throttle cases stub NODE_ENV back to production on purpose. The module reads `THROTTLE_MS` from it,
 * so under the suite's own value the deferral is zero and every publish goes straight out — the window that
 * swallows a snapshot in the app never opens in a test, and a fix to it could not be seen.
 */

const root = resolve(__dirname, "../..");

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  /** Every close RN delivers, including the ones the module itself asks for. */
  closed = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeSocket.instances.push(this);
  }

  send(text: string) { this.sent.push(text); }
  // RN never closes a socket without telling the app, and 1006 is what an unclean drop reports.
  close(code = 1006) {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.closed += 1;
    this.onclose?.({ code });
  }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  frame(value: unknown) { this.readyState = FakeSocket.OPEN; this.onmessage?.({ data: JSON.stringify(value) }); }
  refuse(code: number) { this.readyState = FakeSocket.CLOSED; this.closed += 1; this.onclose?.({ code }); }
}

const RELIANCE = "instrument:v1:NSE:EQ:RELIANCE:CASH";
const NIFTY = "instrument:v1:NSE:INDEX:NIFTY%2050:INDEX";
const STAMP = "2026-11-17T04:30:00Z"; // 10:00 IST

function wire(id: string, price: number) {
  return { id, broker: "icici", accountId: "live", subscriptionId: `s-${id}`, price, exchangeTime: STAMP, fresh: true };
}

async function loadSocket(withProdThrottle = false) {
  vi.resetModules();
  FakeSocket.instances = [];
  vi.stubEnv("NODE_ENV", withProdThrottle ? "production" : "test");
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  return import("../../packages/shared/src/api/websocket.ts");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ===== the throttle window =====

it("paints a snapshot that lands inside the throttle window once the window closes", async () => {
  vi.useFakeTimers();
  const { watchQuotes } = await loadSocket(true);
  const prices: number[][] = [];
  watchQuotes([RELIANCE], (feed) => prices.push(feed.quotes.map((q) => q.price)));
  const socket = FakeSocket.instances[0];
  socket.open();
  const painted = prices.length;

  socket.frame({ mode: "snapshot", quotes: [wire(RELIANCE, 1400)] });
  expect(prices.length, "a frame inside the window is held, not dispatched early").toBe(painted);
  vi.advanceTimersByTime(100);
  // The bug this guards: the held message was rebuilt as an empty id set, which reads as "nothing moved"
  // and skips every watcher, so the screen kept the prices from before the snapshot.
  expect(prices.length, "the held snapshot still reaches the screen when the window closes").toBe(painted + 1);
  expect(prices.at(-1)).toEqual([1400]);
});

it("keeps an unheld frame and a delta that moved nothing apart", async () => {
  vi.useFakeTimers();
  const { watchQuotes } = await loadSocket(true);
  const prices: number[][] = [];
  watchQuotes([RELIANCE], (feed) => prices.push(feed.quotes.map((q) => q.price)));
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.frame({ mode: "snapshot", quotes: [wire(RELIANCE, 1400)] });
  vi.advanceTimersByTime(100);
  const painted = prices.length;

  // An empty delta is a real message with nothing in it, and a screen holding one instrument has no reason
  // to re-render for it. Only the unfiltered publish above may skip the filter.
  socket.frame({ mode: "delta", quotes: [] });
  vi.advanceTimersByTime(100);
  expect(prices.length).toBe(painted);
});

// ===== a socket that carries nothing =====

it("recycles a stream that stays silent for the whole window", async () => {
  vi.useFakeTimers();
  const { watchQuotes } = await loadSocket();
  const seen: { connected: boolean; prices: number[] }[] = [];
  watchQuotes([RELIANCE], (feed) => seen.push({ connected: feed.connected, prices: feed.quotes.map((q) => q.price) }));
  const first = FakeSocket.instances[0];
  first.open();
  first.frame({ mode: "snapshot", quotes: [wire(RELIANCE, 1400)] });
  expect(seen.at(-1)).toEqual({ connected: true, prices: [1400] });

  vi.advanceTimersByTime(Constants.API.WS_SILENCE_MS - 1);
  expect(first.closed, "a stream still inside its window is left alone").toBe(0);
  vi.advanceTimersByTime(1);
  expect(first.closed, "a silent stream is closed rather than waited on").toBe(1);
  // Retiring the pipe also retires the prices it stopped carrying, so the screen's own label moves from
  // live to "Connecting to live prices" instead of holding 1400 as if it had just printed.
  expect(seen.at(-1)).toEqual({ connected: false, prices: [] });

  vi.advanceTimersByTime(Constants.API.WS_RECONNECT_DELAY);
  const second = FakeSocket.instances[1];
  expect(second, "the quiet pipe is replaced").toBeDefined();
  second.open();
  expect(seen.at(-1)?.connected).toBe(true);
});

it("waits out the same silence window the web desk settled on", () => {
  // The web stream moved 20 s → 35 s because a normal quiet stretch in a thin contract outruns 20 s and a
  // reconnect buys nothing but a second snapshot. The two desks chasing different windows is how one app
  // ends up reconnecting hourly while the other reports the feed as healthy.
  expect(Constants.API.WS_SILENCE_MS).toBe(35_000);
});

it("never arms the watchdog for a screen that asked for no instruments", async () => {
  vi.useFakeTimers();
  const { watchQuotes } = await loadSocket();
  watchQuotes([], () => {});
  const socket = FakeSocket.instances[0];
  socket.open();
  // A stream subscribed to nothing answers with nothing, and that is the correct answer rather than an
  // outage — recycling it would reconnect forever against a server that is behaving.
  vi.advanceTimersByTime(Constants.API.WS_SILENCE_MS * 3);
  expect(socket.closed).toBe(0);
});

// ===== retries that do not run out =====

it("keeps retrying a dropped stream while a screen is still watching", async () => {
  vi.useFakeTimers();
  const { watchQuotes } = await loadSocket();
  watchQuotes([RELIANCE], () => {});
  FakeSocket.instances[0].refuse(1006);
  // Ten attempts used to be the budget, and then nothing: a phone that lost the network for a minute came
  // back to prices that never moved again until the app was killed. The wait only grows, and then holds.
  for (let attempt = 1; attempt <= 14; attempt++) {
    const delay = Math.min(
      Constants.API.WS_RECONNECT_DELAY * 2 ** (attempt - 1),
      Constants.API.WS_RECONNECT_MAX_DELAY,
    );
    vi.advanceTimersByTime(delay - 1);
    expect(FakeSocket.instances.length, `attempt ${attempt} waits the full ${delay} ms`).toBe(attempt);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances.length).toBe(attempt + 1);
    FakeSocket.instances[attempt].refuse(1006);
  }
});

it("outlasts a workspace that is already at its three-tab cap", async () => {
  vi.useFakeTimers();
  const { watchQuotes } = await loadSocket();
  watchQuotes([RELIANCE], () => {});
  FakeSocket.instances[0].refuse(1013);
  // 1013 is a tab somewhere else, and tabs close. Retrying at the slow cadence is the whole cure.
  vi.advanceTimersByTime(Constants.API.WS_RECONNECT_DELAY);
  expect(FakeSocket.instances.length).toBe(2);
});

it("stops asking after a policy refusal until the app asks again", async () => {
  vi.useFakeTimers();
  const { watchQuotes, recoverQuoteStream } = await loadSocket();
  watchQuotes([RELIANCE], () => {});
  FakeSocket.instances[0].refuse(1008);
  // A policy close refuses something the server will not change on a timer — the origin, the sign-in, the
  // edition — so the screen keeps its words instead of turning a refusal into load.
  vi.advanceTimersByTime(60_000);
  expect(FakeSocket.instances).toHaveLength(1);
  recoverQuoteStream();
  expect(FakeSocket.instances).toHaveLength(2);
});

it("gives a screen that mounts after a refusal a fresh attempt", async () => {
  vi.useFakeTimers();
  const { watchQuotes } = await loadSocket();
  watchQuotes([RELIANCE], () => {});
  FakeSocket.instances[0].refuse(1008);
  vi.advanceTimersByTime(60_000);
  expect(FakeSocket.instances).toHaveLength(1);

  watchQuotes([NIFTY], () => {});
  // The refusal above belongs to a connection this screen never opened; the budget and the reason both
  // start over, so one dead tab cannot leave every later screen reporting a stream that said no.
  expect(FakeSocket.instances).toHaveLength(2);
});

it("replaces an open stream when the app comes back to the foreground", async () => {
  vi.useFakeTimers();
  const { watchQuotes, recoverQuoteStream } = await loadSocket();
  watchQuotes([RELIANCE], () => {});
  const first = FakeSocket.instances[0];
  first.open();
  first.frame({ mode: "snapshot", quotes: [wire(RELIANCE, 1400)] });
  // A socket the platform suspended over a hidden screen is usually open and empty rather than closed, so
  // returning to the app has to recycle it instead of waiting out the watchdog.
  recoverQuoteStream();
  expect(first.closed).toBe(1);
  vi.advanceTimersByTime(Constants.API.WS_RECONNECT_DELAY);
  expect(FakeSocket.instances.length).toBe(2);
});

it("restarts the stream on the two signals a phone changes without asking", () => {
  const client = readFileSync(resolve(root, "apps/mobile/src/utils/queryClient.ts"), "utf8");
  expect(client).toContain('import { configureApi, quoteStreamConnected, recoverQuoteStream } from "@nraialgo/shared/api"');
  expect(client).toMatch(/if \(connected && !streamWasOnline\) recoverQuoteStream\(\);/);
  expect(client).toMatch(/if \(status === "active" && !quoteStreamConnected\(\)\)/);
});

// ===== the address it dials =====

describe("the socket dials the host the REST client dials", () => {
  it("derives the stream address from the base URL", () => {
    expect(deriveWsUrl("https://myalgodesk.in")).toBe("wss://myalgodesk.in");
    expect(deriveWsUrl("http://10.0.2.2:8000/")).toBe("ws://10.0.2.2:8000");
    expect(Constants.API.WS_URL).toBe(deriveWsUrl(Constants.API.BASE_URL));
  });

  it("keeps exactly one host in the constants", () => {
    const constants = readFileSync(resolve(root, "packages/shared/src/constants/index.ts"), "utf8");
    // Two literals that can disagree is how a device aimed at one host ends up holding prod's socket and
    // declaring prod's `origin` while its own prices go somewhere else.
    expect(constants).not.toMatch(/WS_URL:\s*"wss?:\/\//);
    expect(constants.match(/https:\/\/myalgodesk\.in/g)).toHaveLength(1);
  });
});
