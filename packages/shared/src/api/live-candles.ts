/**
 * Live candles from prod's tick stream.
 *
 * A stream frame carries a price and its exchange timestamp, never a bar, so the forming candle is built here
 * with the same bucket math as the backend recorder (services/market_data/candles.py) and the web desk
 * (components/chart/live-bar.ts): intraday buckets start at the 09:15 IST session open, the 15:30 closing print
 * belongs to the last bucket, ticks outside the session are ignored, and daily/weekly/monthly bars start at IST
 * midnight / Monday / the 1st. A tick never invents a bar the record did not earn: history keeps its open.
 */

import { useMemo, useRef } from "react";
import { chartInstrument, type Candle } from "./hooks";
import { useQuoteSubscription, type FeedReason, type QuoteTick } from "./websocket";
import { useInstrumentTick, useQuoteStore } from "./quote-store";

/** Intervals the chart draws. Minutes and hours are session buckets; the rest start at an IST boundary. */
export type ChartBucket = "1m" | "3m" | "5m" | "10m" | "15m" | "30m" | "1h" | "1d" | "1w" | "1M";

const IST_OFFSET = 19_800_000;
const DAY = 86_400_000;
const OPEN = 33_300_000; // 09:15 after IST midnight
const CLOSE = 55_800_000; // 15:30
const BUCKET_MS: Partial<Record<ChartBucket, number>> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "10m": 600_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000,
};

export function istDayStart(ts: number): number {
  return Math.floor((ts + IST_OFFSET) / DAY) * DAY - IST_OFFSET;
}

/** Start (ms epoch) of the bar containing `ts`, or null when `ts` is outside the trading session. */
export function bucketStart(ts: number, interval: ChartBucket): number | null {
  if (!Number.isFinite(ts)) return null;
  const day = istDayStart(ts);
  const offset = ts - day;
  if (offset < OPEN || offset > CLOSE) return null;
  const bucket = BUCKET_MS[interval];
  if (bucket !== undefined) {
    const probe = offset === CLOSE ? offset - 1 : offset;
    return day + OPEN + Math.floor((probe - OPEN) / bucket) * bucket;
  }
  if (interval === "1d") return day;
  if (interval === "1w") return day - (((Math.floor((ts + IST_OFFSET) / DAY) + 3) % 7) * DAY);
  if (interval === "1M") {
    const local = new Date(ts + IST_OFFSET);
    return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - IST_OFFSET;
  }
  return null;
}

/** The bar after one tick, or null when the tick cannot be used (bad price, outside session, older than `previous`). */
export function applyTick(previous: Candle | undefined, interval: ChartBucket, price: number, ts: number): Candle | null {
  if (!(price > 0) || !Number.isFinite(price)) return null;
  const start = bucketStart(ts, interval);
  if (start === null) return null;
  if (previous && start < previous.timestamp) return null;
  if (previous && start === previous.timestamp) {
    return { ...previous, high: Math.max(previous.high, price), low: Math.min(previous.low, price), close: price };
  }
  return { timestamp: start, open: price, high: price, low: price, close: price };
}

/** Whether a bar at `ts` belongs to the bucket that starts at `start`. */
function inBucket(ts: number, start: number, interval: ChartBucket): boolean {
  if (ts < start) return false;
  if (BUCKET_MS[interval] !== undefined) return bucketStart(ts, interval) === start;
  if (interval === "1d") return istDayStart(ts) === start;
  if (interval === "1w") return ts - start < 7 * DAY;
  const bar = new Date(ts + IST_OFFSET);
  const bucket = new Date(start + IST_OFFSET);
  return bar.getUTCFullYear() === bucket.getUTCFullYear() && bar.getUTCMonth() === bucket.getUTCMonth();
}

/**
 * One bar for the bucket containing `at`, folded from every loaded bar inside it. This is what gives a daily or
 * weekly candle its true open before the first live tick of the period arrives: today's session bars carry
 * today's open, and this week's daily bars carry Monday's.
 */
export function foldBucket(bars: readonly Candle[], interval: ChartBucket, at: number | null): Candle | null {
  if (at === null) return null;
  const start = bucketStart(at, interval);
  if (start === null) return null;
  const rows = bars.filter((bar) => Number.isFinite(bar.timestamp) && inBucket(bar.timestamp, start, interval));
  if (!rows.length) return null;
  const ordered = rows.slice().sort((a, b) => a.timestamp - b.timestamp);
  const volumes = ordered.map((bar) => bar.volume);
  const volume = volumes.every((value) => typeof value === "number")
    ? volumes.reduce<number>((total, value) => total + (value as number), 0)
    : undefined;
  return {
    timestamp: start,
    open: ordered[0].open,
    high: Math.max(...ordered.map((bar) => bar.high)),
    low: Math.min(...ordered.map((bar) => bar.low)),
    close: ordered[ordered.length - 1].close,
    ...(volume === undefined ? {} : { volume }),
  };
}

const INDEX_ALIASES: Record<string, string> = {
  NIFTY: "NIFTY 50",
  NIFTY50: "NIFTY 50",
  "NIFTY 50": "NIFTY 50",
  BANKNIFTY: "NIFTY BANK",
  NIFTYBANK: "NIFTY BANK",
  "BANK NIFTY": "NIFTY BANK",
  "NIFTY BANK": "NIFTY BANK",
  FINNIFTY: "NIFTY FIN SERVICE",
  "NIFTY FIN SERVICE": "NIFTY FIN SERVICE",
  "NIFTY FINANCIAL SERVICES": "NIFTY FIN SERVICE",
  MIDCPNIFTY: "NIFTY MID SELECT",
  "MIDCAP SELECT": "NIFTY MID SELECT",
  "NIFTY MID SELECT": "NIFTY MID SELECT",
  "INDIA VIX": "INDIA VIX",
  INDIAVIX: "INDIA VIX",
  SENSEX: "SENSEX",
  BANKEX: "BANKEX",
};

const INDEX_NAMES = new Set([
  "NIFTY 50", "NIFTY BANK", "NIFTY FIN SERVICE", "NIFTY MID SELECT", "NIFTY MIDCAP 100", "NIFTY SMALLCAP 100", "INDIA VIX",
  "NIFTY", "NIFTY50", "BANKNIFTY", "NIFTYBANK", "BANK NIFTY", "FINNIFTY", "MIDCPNIFTY", "INDIAVIX",
]);

/**
 * The canonical id the quote stream subscribes by, or null for anything the stream does not publish. The grammar
 * is brokers/shared/instrument_registry.py; a wrong id closes the socket, so only NSE cash symbols and NSE
 * indices can be charted live here, exactly as the web desk restricts it.
 */
export function streamId(name: string): string | null {
  const key = chartInstrument(name);
  if (!key) return null;
  const [exchange, ...rest] = key.split(":");
  const symbol = rest.join(":");
  if (exchange !== "NSE" || !symbol) return null;
  const canonical = INDEX_ALIASES[symbol.trim().toUpperCase()] ?? symbol.trim().toUpperCase();
  if (INDEX_NAMES.has(canonical) || INDEX_NAMES.has(symbol)) {
    return `instrument:v1:NSE:INDEX:${encodeURIComponent(canonical)}:INDEX`;
  }
  return `instrument:v1:NSE:EQ:${encodeURIComponent(symbol)}:CASH`;
}

/** The listed symbol a canonical id was built from, so stream ticks can patch caches keyed by symbol. */
export function symbolFromStreamId(id: string): string {
  const parts = id.split(":");
  if (parts.length < 5 || parts[0] !== "instrument" || parts[1] !== "v1") return "";
  try {
    // instrument:v1:<EXCHANGE>:<SEGMENT>:<SYMBOL>:<KIND>[:...] - the symbol is the fifth part, not the segment.
    return decodeURIComponent(parts[4] ?? "");
  } catch {
    return "";
  }
}

/** A tick only paints a bar when the server published it as fresh and the exchange stamped it. */
export function tickBarInput(tick: QuoteTick | undefined): { price: number; at: number } | null {
  if (!tick || tick.fresh !== true) return null;
  if (!(tick.price > 0) || !Number.isFinite(tick.price)) return null;
  if (tick.at === null || !Number.isFinite(tick.at)) return null;
  return { price: tick.price, at: tick.at };
}

const STATUS_LABELS: Record<string, string> = {
  LIVE: "Live",
  DELAYED: "Delayed",
  STALE: "Stale",
  FALLBACK: "Broker fallback",
  MARKET_CLOSED: "Market closed",
  LAST_CLOSE: "Last close",
  NO_DATA: "No data yet",
  DISCONNECTED: "Disconnected",
};

/**
 * Plain words for what the stream says about this price, so a quiet screen never reads as a broken one, a
 * refused socket never reads as a slow one, and a stale price never dresses up as a live one.
 */
export function tickLabel(tick: QuoteTick | null | undefined, connected: boolean, reason: FeedReason = null): string {
  if (reason === "policy") return "The live price stream refused this device";
  if (reason === "capacity") return "This account already has three live streams open";
  if (!connected) return "Connecting to live prices";
  if (!tick) return "Waiting for a live tick";
  const status = tick.status
    ? STATUS_LABELS[tick.status.toUpperCase()] ?? tick.status
    : tick.fresh
      ? "Live"
      : "Latest";
  return `${status} price ${tick.price.toFixed(2)}`;
}

export interface LiveCandles {
  /** The bars to draw: the loaded record, with the current bucket replaced by the tick-fed bar. */
  points: Candle[];
  /** The live bar of the current bucket, or null while neither the record nor a tick offers one. */
  bar: Candle | null;
  tick: QuoteTick | null;
  /** Exchange time of that tick, so a quiet screen can say how old its last price really is. */
  at: number | null;
  connected: boolean;
  /** Why the socket is not carrying prices, when it is not. */
  reason: FeedReason;
  states: Record<string, string>;
  /** Null when this symbol is on the stream; otherwise the plain reason it can never tick. */
  unavailable: string | null;
}

/**
 * The priors for one bucket, folded together before a new price extends them.
 *
 * `record` is what the loaded data says about this bucket and `carried` is what this device's own earlier
 * ticks saw. A bar's high and low are the prices it has actually traded, so both must survive: the record
 * alone forgets the ticks between its polls, and the carried bar alone forgets a stored open or an extreme
 * the record holds. A bucket with no record still gets its extrema from the ticks it saw, and a bucket the
 * record no longer covers is not this tick's bucket at all.
 */
export function foldPriors(record: Candle | undefined, carried: Candle | undefined): Candle | undefined {
  if (!record || !carried) return record ?? carried;
  if (record.timestamp !== carried.timestamp) return record;
  return { ...record, high: Math.max(record.high, carried.high), low: Math.min(record.low, carried.low) };
}

/**
 * Candles that move with the stream.
 *
 * `base` is what the chart route loaded for this interval (its stored bars plus the forming candle it already
 * has). `extras` are bars of a finer interval for the same period - today's session bars behind a daily chart -
 * folded into the bucket so the live bar keeps a true open instead of the first price this device happened to
 * see. Every fresh tick extends that bucket bar, and each record load re-seeds it, so a poll can never draw a
 * candle behind the live price.
 */
export function useLiveCandles(
  name: string,
  interval: ChartBucket,
  base: readonly Candle[],
  extras: readonly Candle[] = [],
  enabled = true,
): LiveCandles {
  const id = useMemo(() => streamId(name), [name]);
  useQuoteSubscription(id ? [id] : [], !!id && enabled);
  const tick = useInstrumentTick(enabled ? id : null) ?? null;
  const connected = useQuoteStore((s) => s.connected);
  const reason = useQuoteStore((s) => s.reason);
  const states = useQuoteStore((s) => s.states);

  // Only a price the server published as fresh, with a positive value and an exchange stamp, may move a bar.
  const usable = tickBarInput(tick ?? undefined);
  const at = usable?.at ?? null;
  const activeBucketStart = at !== null ? bucketStart(at, interval) : null;

  const seed = useMemo(() => {
    if (activeBucketStart === null) return base.length ? base[base.length - 1] : null;
    return foldBucket(extras.length ? [...base, ...extras] : base, interval, activeBucketStart);
  }, [base, extras, interval, activeBucketStart]);

  // What this device has already seen in the current bucket. Keyed by symbol, interval and bucket start,
  // so a re-seeded record, a rolled bucket or a switched chart cannot fold an unrelated bar into this one,
  // and a second invocation of the same tick merges a bar with itself.
  const seen = useRef<{ key: string; bar: Candle } | null>(null);

  const bar = useMemo(() => {
    const hit = tickBarInput(tick ?? undefined);
    if (!hit || activeBucketStart === null) return seed;
    const key = `${name}|${interval}|${activeBucketStart}`;
    const carried = seen.current?.key === key ? seen.current.bar : undefined;
    const previous = foldPriors(seed && seed.timestamp === activeBucketStart ? seed : undefined, carried);
    const next = applyTick(previous, interval, hit.price, hit.at);
    if (!next) return seed;
    seen.current = { key, bar: next };
    return next;
  }, [tick, seed, interval, name, activeBucketStart]);

  const points = useMemo(() => {
    if (!bar) return [...base];
    const last = base[base.length - 1];
    if (last && last.timestamp === bar.timestamp) {
      const copy = base.slice();
      copy[copy.length - 1] = bar;
      return copy;
    }
    if (last && last.timestamp > bar.timestamp) return [...base];
    return [...base, bar];
  }, [base, bar]);

  return {
    points,
    bar,
    tick,
    at,
    connected,
    reason,
    states,
    unavailable: id
      ? null
      : `${chartInstrument(name)} is not on the live price stream: only NSE cash symbols and NSE indices are published tick by tick.`,
  };
}

/**
 * The index strip's stream ids, or null when any index on it has no stream id, so a poll gated on them
 * keeps its normal read. The strip component and the watchlist tab read the same cached strip and must
 * hand the same ids to it, because each observer schedules its own timer.
 */
export function indexStreamIds(indices: readonly { name: string }[] | undefined): string[] | null {
  if (!indices || indices.length === 0) return null;
  const ids = indices.map((idx) => streamId(idx.name));
  return ids.every((id): id is string => !!id) ? (ids as string[]) : null;
}
