/**
 * Whether the phone is allowed to read the broker at all, and what to say when it is not.
 *
 * Two prod routes answer this, and the phone needs both to tell one state from another:
 * `/v1/broker-credentials/status` proves the broker's API keys are saved on the server, while
 * `/v1/broker-auth/status` answers only with sessions whose `expires_at` is still in the future. A null in
 * the second map therefore means two entirely different things depending on the first — never authorized, or
 * authorized and since run out — and those two sentences send a trader to different actions.
 *
 * The app cannot fix either one. Broker credentials are saved over HTTPS by a browser, and the phone holds
 * no broker password, so every state here names the web desk instead of drawing a button that would fail.
 */

import { formatISTDate, formatISTTime, isTodayIST } from "../utils";

/** What each of the two routes answers: one ISO timestamp per provider the edition exposes, or null. */
export type ProviderTimestamps = Record<string, string | null>;

/**
 * `expired` is reachable from a cache alone: the read succeeded while the session was alive and the phone is
 * still showing it minutes later. That is why the screen compares against the clock on every render rather
 * than trusting the state the response carried.
 */
export type ConnectionState = "live" | "expiring" | "expired" | "never-authorized" | "no-credentials";

export interface BrokerConnection {
  provider: string;
  /** The broker's own product name, taken from the web desk's gateway list. */
  name: string;
  credentialsAt: string | null;
  sessionUntil: string | null;
  state: ConnectionState;
}

/** Breeze sessions are re-authorized by hand, so the last stretch is worth naming before it runs out. */
const WARNING_WINDOW_MS = 30 * 60 * 1000;

const PROVIDER_NAMES: Record<string, string> = {
  icici: "ICICI Direct Breeze",
  zerodha: "Zerodha Kite",
  kotak: "Kotak Neo",
  angel: "Angel One",
};

/** The order the web desk lists them in, so the phone and the browser do not reorder the same account. */
const PROVIDER_ORDER = ["icici", "zerodha", "kotak", "angel"];

/** The name a trader uses in speech, for the one line the More card has room for. */
const PROVIDER_SHORT_NAMES: Record<string, string> = {
  icici: "ICICI",
  zerodha: "Zerodha",
  kotak: "Kotak",
  angel: "Angel One",
};

/** An ISO string the server meant, or null. Anything unparseable is treated as absent, never as zero. */
function stamp(value: string | null | undefined): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

export function connectionState(credentialsAt: string | null, sessionUntil: string | null, now: number): ConnectionState {
  if (!credentialsAt) return "no-credentials";
  if (!sessionUntil) return "never-authorized";
  const until = Date.parse(sessionUntil);
  if (until <= now) return "expired";
  return until - now <= WARNING_WINDOW_MS ? "expiring" : "live";
}

/**
 * The two status maps folded into one list per provider. A provider either route mentions appears, because
 * an edition can leave one out of a response entirely, and "we know nothing about Angel One" is a different
 * fact from "Angel One has no session".
 */
export function brokerConnections(
  credentials: ProviderTimestamps | null | undefined,
  session: ProviderTimestamps | null | undefined,
  now: number = Date.now(),
): BrokerConnection[] {
  const saved = credentials && typeof credentials === "object" ? credentials : {};
  const live = session && typeof session === "object" ? session : {};
  const providers = [...new Set([...Object.keys(saved), ...Object.keys(live)])];
  return providers
    .map(provider => {
      const credentialsAt = stamp(saved[provider]);
      const sessionUntil = stamp(live[provider]);
      return { provider, name: providerName(provider), credentialsAt, sessionUntil, state: connectionState(credentialsAt, sessionUntil, now) };
    })
    .sort((a, b) => {
      const rank = (provider: string) => {
        const at = PROVIDER_ORDER.indexOf(provider);
        return at === -1 ? PROVIDER_ORDER.length : at;
      };
      return rank(a.provider) - rank(b.provider) || a.provider.localeCompare(b.provider);
    });
}

/** The broker's spoken name, for the single line the More card has room for. */
export function shortProviderName(provider: string): string {
  return PROVIDER_SHORT_NAMES[provider] ?? provider;
}

/** Hours and minutes on the account's own clock, with the date once it is no longer today in IST. */
export function clockWord(value: string, now: number = Date.now()): string {
  const time = formatISTTime(value);
  return isTodayIST(value) ? time : `${formatISTDate(value)} ${time}`;
}

export function agoWord(from: number, now: number): string {
  const elapsed = Math.max(0, now - from);
  if (elapsed < 60_000) return "just now";
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Whole minutes a session still has. An absent stamp has none. */
function minutesLeft(until: string | null, now: number): number {
  return until ? Math.max(1, Math.round((Date.parse(until) - now) / 60_000)) : 0;
}

/** Whether the app can reach the broker through this connection right now. */
export function isConnected(connection: BrokerConnection, now: number = Date.now()): boolean {
  const state = connectionState(connection.credentialsAt, connection.sessionUntil, now);
  return state === "live" || state === "expiring";
}

/**
 * The one line a row or a card prints for a connection. Never a dash, never "Unavailable".
 *
 * The state is re-derived from `now` instead of read off `connection.state`, because a response cached while
 * the session was alive still has to say "Session ended" an hour later without a network read.
 */
export function connectionWord(connection: BrokerConnection, now: number = Date.now()): string {
  if (!connection.credentialsAt) return "No broker credentials saved";
  const until = connection.sessionUntil;
  if (!until) return "Credentials saved, not connected";
  const at = Date.parse(until);
  if (at <= now) return `Session ended ${agoWord(at, now)}`;
  const left = at - now;
  const clock = clockWord(until, now);
  return left <= WARNING_WINDOW_MS
    ? `Connected until ${clock} (${minutesLeft(until, now)} min left)`
    : `Connected until ${clock}`;
}

/** What the trader can actually do about it, on the one host this build talks to. */
export function connectionAdvice(connection: BrokerConnection, host: string, now: number = Date.now()): string {
  const state = connectionState(connection.credentialsAt, connection.sessionUntil, now);
  switch (state) {
    case "no-credentials":
      return `Save the broker's API credentials once on ${host}. This app never asks for your broker password.`;
    case "never-authorized":
      return `Authorize a session on ${host}. Until one is live this app cannot read positions, orders or prices.`;
    case "expired":
      return `Re-authorize on ${host}. Every tab restarts from the next live read of the broker.`;
    case "expiring":
      return `Runs out in ${minutesLeft(connection.sessionUntil, now)} min. Re-authorize on ${host} before the next session to keep the screens updating.`;
    default:
      return "Nothing to do. The app reads the account through this session.";
  }
}

/** Colour is a signal on a status screen, so it is derived from the state and never set per row. */
export function connectionTone(state: ConnectionState): "good" | "warn" | "bad" {
  if (state === "live") return "good";
  if (state === "expiring") return "warn";
  return "bad";
}

/** The headline the More card prints when the app has no broker to talk about yet. */
export const NO_BROKER_WORD = "No broker connected";

/**
 * The single line the More card can afford for the whole account.
 *
 * `state` carries the read's own failure: a server that did not answer is not the same fact as a broker with
 * no live session, and printing "No broker connected" for the first would send the trader to re-authorize a
 * connection that is fine. With more than one broker live the row counts them instead of naming one, because
 * naming only the first would read as though the others were down.
 */
export function brokerSummary(
  connections: BrokerConnection[],
  state: "ready" | "loading" | "failed",
  now: number = Date.now(),
): string {
  if (state === "loading") return "Checking…";
  if (state === "failed") return "Could not be read just now";
  const live = connections.filter(connection => isConnected(connection, now));
  if (live.length > 1) return `${live.length} brokers connected`;
  const first = live[0];
  if (first?.sessionUntil) return `${shortProviderName(first.provider)} · until ${clockWord(first.sessionUntil, now)}`;
  if (connections.some(connection => connection.credentialsAt)) return "Credentials saved, not connected";
  return NO_BROKER_WORD;
}
