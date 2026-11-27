import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agoWord,
  brokerConnections,
  brokerSummary,
  clockWord,
  connectionAdvice,
  connectionState,
  connectionTone,
  connectionWord,
  isConnected,
  NO_BROKER_WORD,
  providerName,
  shortProviderName,
  type BrokerConnection,
} from "../../packages/shared/src/api/broker-connection.ts";

/**
 * The phone trades through a broker session it cannot see. Until now the app's only broker read pointed at
 * `/v1/auth/brokers`, a route the backend never registered, so `useBrokers()` could only ever have failed and
 * no screen asked the question a trader actually has: is the broker still reachable, and until when.
 *
 * Prod answers that with two maps, and the interesting cases are the ones where the two disagree — credentials
 * with no session, a session that has since run out, one route naming a provider the other does not. These
 * cases pin the fold, and the words each state is allowed to print.
 */

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-27T04:00:00Z"); // 09:30 IST, the session's first hour
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const row = (
  provider: string,
  credentialsAt: string | null,
  sessionUntil: string | null,
): BrokerConnection => ({
  provider,
  name: providerName(provider),
  credentialsAt,
  sessionUntil,
  state: connectionState(credentialsAt, sessionUntil, NOW),
});

describe("Two status maps fold into one answer", () => {
  it("calls a live session live", () => {
    const [only] = brokerConnections({ icici: iso(-40 * 24 * HOUR) }, { icici: iso(6 * HOUR) }, NOW);
    expect(only?.state).toBe("live");
    expect(isConnected(only!, NOW)).toBe(true);
    expect(connectionTone(only!.state)).toBe("good");
  });

  it("warns before a session runs out instead of at the moment it does", () => {
    const [only] = brokerConnections({ icici: iso(-40 * 24 * HOUR) }, { icici: iso(20 * 60_000) }, NOW);
    expect(only?.state).toBe("expiring");
    expect(connectionTone(only!.state)).toBe("warn");
    expect(connectionWord(only!, NOW)).toContain("20 min left");
  });

  it("splits credentials that were saved from a session that was ever authorized", () => {
    // This is the pair the two routes exist for: a null session alone cannot say which of these happened.
    const [only] = brokerConnections({ icici: iso(-40 * 24 * HOUR) }, { icici: null }, NOW);
    expect(only?.state).toBe("never-authorized");
    expect(connectionWord(only!, NOW)).toBe("Credentials saved, not connected");
    expect(connectionAdvice(only!, "myalgodesk.in", NOW)).toContain("Authorize a session on myalgodesk.in");
  });

  it("keeps a dead session as a different fact from one that never started", () => {
    const [only] = brokerConnections({ icici: iso(-40 * 24 * HOUR) }, { icici: iso(-2 * HOUR) }, NOW);
    expect(only?.state).toBe("expired");
    expect(connectionWord(only!, NOW)).toBe("Session ended 2 hours ago");
    expect(connectionAdvice(only!, "myalgodesk.in", NOW)).toContain("Re-authorize on myalgodesk.in");
    expect(connectionTone(only!.state)).toBe("bad");
  });

  it("says nothing is saved when the credentials route says so", () => {
    const [only] = brokerConnections({ icici: null }, { icici: iso(6 * HOUR) }, NOW);
    expect(only?.state).toBe("no-credentials");
    expect(connectionWord(only!, NOW)).toBe("No broker credentials saved");
  });

  it("lists a provider one route mentioned and the other did not", () => {
    // An edition can leave a gateway out of one response entirely; "nothing is known" must not read as
    // "not connected" without the other map being consulted.
    const rows = brokerConnections({ icici: iso(-40 * 24 * HOUR), angel: null }, { icici: iso(6 * HOUR) }, NOW);
    expect(rows.map(r => r.provider)).toEqual(["icici", "angel"]);
    expect(rows[1]?.state).toBe("no-credentials");
  });

  it("answers with no rows when neither route knows a broker", () => {
    expect(brokerConnections({}, {}, NOW)).toEqual([]);
    expect(brokerSummary([], "ready", NOW)).toBe(NO_BROKER_WORD);
  });

  it("treats a timestamp it cannot read as absent, never as the epoch", () => {
    const [only] = brokerConnections({ icici: "0000-00-00T00:00:00Z" }, { icici: "yesterday" }, NOW);
    expect(only?.credentialsAt).toBeNull();
    expect(only?.sessionUntil).toBeNull();
    expect(only?.state).toBe("no-credentials");
  });

  it("keeps ICICI first, the order the web desk lists", () => {
    const keys = { zerodha: iso(6 * HOUR), icici: iso(6 * HOUR), angel: iso(6 * HOUR), kotak: iso(6 * HOUR) };
    const rows = brokerConnections(keys, keys, NOW);
    expect(rows.map(r => r.provider)).toEqual(["icici", "zerodha", "kotak", "angel"]);
  });

  it("survives a response that is not an object", () => {
    expect(brokerConnections(null, undefined, NOW)).toEqual([]);
  });
});

describe("A cached answer still tells the truth an hour later", () => {
  // The read is cached for 30s and the screen ticks on a local clock, so the words must be re-derived from the
  // timestamps rather than from the state the response carried.
  const stale = row("icici", iso(-40 * 24 * HOUR), iso(1 * HOUR));

  it("reports the session as ended once the clock passes it", () => {
    expect(stale.state).toBe("live");
    expect(connectionState(stale.credentialsAt, stale.sessionUntil, NOW + 2 * HOUR)).toBe("expired");
    expect(connectionWord(stale, NOW + 2 * HOUR)).toBe("Session ended 1 hour ago");
    expect(isConnected(stale, NOW + 2 * HOUR)).toBe(false);
  });

  it("counts down the last stretch without a new read", () => {
    expect(connectionWord(stale, NOW + 55 * 60_000)).toContain("5 min left");
  });

  it("keeps the advice matching the older state, not the folded one", () => {
    expect(connectionAdvice(stale, "myalgodesk.in", NOW + 2 * HOUR)).toContain("Re-authorize");
  });
});

describe("Every state gets a sentence, none gets a dash", () => {
  const states: Array<[string, string | null, string | null]> = [
    ["no-credentials", null, null],
    ["never-authorized", iso(-40 * 24 * HOUR), null],
    ["expired", iso(-40 * 24 * HOUR), iso(-3 * HOUR)],
    ["expiring", iso(-40 * 24 * HOUR), iso(10 * 60_000)],
    ["live", iso(-40 * 24 * HOUR), iso(6 * HOUR)],
  ];

  it.each(states)("prints a real line for %s", (_label, credentialsAt, sessionUntil) => {
    const connection = row("icici", credentialsAt, sessionUntil);
    const word = connectionWord(connection, NOW);
    const advice = connectionAdvice(connection, "myalgodesk.in", NOW);
    expect(word.length).toBeGreaterThan(10);
    expect(advice.length).toBeGreaterThan(20);
    // The words this app refused in the More audit: a blank, a dash or "Unavailable" where the server knows why.
    for (const text of [word, advice]) {
      expect(text).not.toMatch(/^\s*$|^—$|-$/);
      expect(text).not.toContain("Unavailable");
      expect(text).not.toContain("Coming soon");
    }
  });

  it("points every broken state at the host that can fix it", () => {
    for (const [, credentialsAt, sessionUntil] of states) {
      const advice = connectionAdvice(row("icici", credentialsAt, sessionUntil), "myalgodesk.in", NOW);
      const live = connectionState(credentialsAt, sessionUntil, NOW) === "live";
      expect(advice.includes("myalgodesk.in")).toBe(!live);
    }
  });
});

describe("The More card line for the whole account", () => {
  it("uses the broker's own name and passes an unknown one through", () => {
    expect(shortProviderName("icici")).toBe("ICICI");
    expect(shortProviderName("upstox")).toBe("upstox");
  });

  it("says checking while the status read is in flight", () => {
    expect(brokerSummary([], "loading", NOW)).toBe("Checking…");
  });

  it("does not report a missing broker because the server did not answer", () => {
    expect(brokerSummary([], "failed", NOW)).toBe("Could not be read just now");
    expect(brokerSummary([{ ...row("icici", iso(-24 * HOUR), iso(6 * HOUR)) }], "failed", NOW))
      .toBe("Could not be read just now");
  });

  it("names the broker and its clock when one is connected", () => {
    const [icici] = brokerConnections({ icici: iso(-24 * HOUR) }, { icici: iso(6 * HOUR) }, NOW);
    const line = brokerSummary([icici!], "ready", NOW);
    expect(line).toContain("ICICI");
    expect(line).toContain("until");
    expect(line).toContain(clockWord(iso(6 * HOUR), NOW));
  });

  it("counts brokers when the edition has more than one live", () => {
    const keys = { icici: iso(6 * HOUR), zerodha: iso(6 * HOUR) };
    expect(brokerSummary(brokerConnections(keys, keys, NOW), "ready", NOW)).toBe("2 brokers connected");
  });

  it("falls back to credentials when no session is alive", () => {
    const [icici] = brokerConnections({ icici: iso(-24 * HOUR) }, { icici: null }, NOW);
    expect(brokerSummary([icici!], "ready", NOW)).toBe("Credentials saved, not connected");
  });

  it("ages the read the trader is looking at", () => {
    expect(agoWord(NOW - 30_000, NOW)).toBe("just now");
    expect(agoWord(NOW - 9 * 60_000, NOW)).toBe("9 min ago");
    expect(agoWord(NOW - 2 * HOUR, NOW)).toBe("2 hours ago");
    expect(agoWord(NOW - 5 * 24 * HOUR, NOW)).toBe("5 days ago");
  });
});

describe("The app reads the two routes prod registers", () => {
  const hooks = readFileSync(resolve("packages/shared/src/api/hooks.ts"), "utf8");
  const constants = readFileSync(resolve("packages/shared/src/constants/index.ts"), "utf8");
  const screen = readFileSync(resolve("apps/mobile/app/broker-connection.tsx"), "utf8");
  const more = readFileSync(resolve("apps/mobile/app/(tabs)/more.tsx"), "utf8");

  it("drops the broker hook that named a route the backend never registered", () => {
    expect(hooks).not.toContain("/v1/auth/brokers");
    expect(hooks).not.toContain("useBrokers");
    expect(hooks).not.toContain('["auth", "brokers"]');
    expect(constants).not.toContain("AUTH_BROKERS");
  });

  it("reads credentials and sessions together as one query", () => {
    expect(hooks).toContain('"/v1/broker-credentials/status"');
    expect(hooks).toContain('"/v1/broker-auth/status"');
    expect(hooks).toContain("brokerConnections(credentials, session)");
    expect(hooks).toContain('queryKeys.auth.brokerConnection()');
  });

  it("hands the hook to the screens through the api factory", () => {
    expect(hooks).toMatch(/\n\s*useMe,\n\s*useBrokerConnection,\n/);
    expect(more).toContain("useBrokerConnection");
    expect(screen).toContain("useBrokerConnection()");
  });

  it("keeps the screen read-only: it writes nothing to the broker", () => {
    // Connecting a broker means saving credentials and pasting a session token, which is B2's design pass.
    expect(screen).not.toMatch(/client\.(post|put|patch|delete)/);
    expect(screen).not.toMatch(/useMutation|\.mutate\(/);
    expect(screen).toContain("RefreshControl");
  });

  it("tells the trader the phone cannot fix a dead session", () => {
    expect(screen).toContain("This app never holds a broker password");
    expect(screen).toContain("serverLine()");
    expect(screen).toContain("{host}");
  });

  it("keeps the row that opens the screen pressable and chevroned", () => {
    expect(existsSync(resolve("apps/mobile/app/broker-connection.tsx"))).toBe(true);
    expect(more).toContain('router.push("/broker-connection")');
    const chevrons = (more.match(/chevron-forward-outline/g) ?? []).length;
    const pushes = (more.match(/router\.push\(/g) ?? []).length;
    expect(chevrons).toBe(pushes);
  });

  it("re-derives the copy on a clock instead of the cache age", () => {
    expect(more).toContain("useClock()");
    expect(screen).toContain("useClock()");
  });

  it("ages the credentials from the stamp the server sent, not from a date the phone invents", () => {
    expect(screen).toContain("connectionWord(connection, now)");
    expect(screen).toContain("connectionAdvice(connection, host, now)");
    expect(screen).toContain("agoWord(Date.parse(connection.credentialsAt), now)");
  });
});
