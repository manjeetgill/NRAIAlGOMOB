import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  liveNotices,
  noticeSummary,
  noticeTitle,
  unreadNotices,
  unshownNotices,
  type OrderNotice,
} from "../../packages/shared/src/api/order-inbox.ts";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const inbox = read("packages/shared/src/api/hooks.ts");
const sse = read("packages/shared/src/api/sse.ts");
const shell = read("apps/mobile/app/_layout.tsx");
const tabs = read("apps/mobile/app/(tabs)/_layout.tsx");
const orders = read("apps/mobile/app/(tabs)/orders.tsx");
const toast = read("apps/mobile/src/components/OrderNoticeToast.tsx");
const list = read("apps/mobile/src/components/OrderNoticeList.tsx");
const barrel = read("packages/shared/src/api/index.ts");

/** One projector row, as prod sends it: the words are already in `payload`. */
const row = (over: Partial<OrderNotice>): OrderNotice => ({
  id: 1,
  mode: "live",
  event_kind: "executed",
  payload: { title: "Live order executed", summary: "BUY 130 NIFTY26NOV25600CE @ 96.50 · avg 96.50" },
  occurred_at: "2026-11-27T09:22:03+00:00",
  read_at: null,
  ...over,
});

/**
 * The phone reads the inbox prod already projects and says nothing of its own.
 *
 * Orders used to reach the trader only by opening the Orders tab. The server has an owner-scoped order inbox
 * (`GET /v1/alerts/orders`, projected every five seconds from committed order evidence) that the web desk and
 * WhatsApp already read, so the mobile surface is a reader of it: live rows only, the server's words, and no
 * verb that could disturb a paper row the phone never shows.
 */

describe("the inbox the phone reads is the live one", () => {
  it("keeps live rows in the server's order", () => {
    const rows = liveNotices({ notifications: [row({ id: 3 }), row({ id: 1 })] });
    expect(rows.map((r) => r.id)).toEqual([3, 1]);
  });

  it("drops every paper row even when the server listed it", () => {
    const rows = liveNotices({
      notifications: [row({ id: 2 }), row({ id: 4, mode: "paper", payload: { title: "Paper order placed" } })],
    });
    expect(rows.map((r) => r.id)).toEqual([2]);
  });

  it("reads a body with no rows as an empty inbox rather than throwing", () => {
    expect(liveNotices(undefined)).toEqual([]);
    expect(liveNotices({ notifications: null })).toEqual([]);
    expect(liveNotices({ notifications: [null as unknown as OrderNotice, row({})] }).map((r) => r.id)).toEqual([1]);
  });

  it("counts unread from the rows, not from the server's all-modes figure", () => {
    const rows = [row({ id: 5 }), row({ id: 6, read_at: "2026-11-27T09:30:00+00:00" })];
    expect(unreadNotices(rows).map((r) => r.id)).toEqual([5]);
  });
});

describe("a notice is titled with the server's words", () => {
  it("keeps the title exactly as the projector wrote it", () => {
    expect(noticeTitle(row({ event_kind: "leg_filled", payload: { title: "Live basket leg 2/4 partially executed" } })))
      .toBe("Live basket leg 2/4 partially executed");
  });

  it("words the kind when a row arrives with no title, instead of printing a blank line", () => {
    expect(noticeTitle(row({ payload: null }))).toBe("Order executed");
    expect(noticeTitle(row({ event_kind: "failed", payload: { title: "  " } }))).toBe("Order failed");
    expect(noticeTitle(row({ event_kind: "attention" })).length).toBeGreaterThan(0);
  });

  it("says something for a kind this app has not seen", () => {
    expect(noticeTitle(row({ event_kind: "tomorrow_kind", payload: {} }))).toBe("Order notice");
  });

  it("leaves a missing summary empty so the screen hides the line", () => {
    expect(noticeSummary(row({ payload: { title: "Live order placed", summary: "" } }))).toBe("");
    expect(noticeSummary(row({ payload: { summary: "  " } }))).toBe("");
  });
});

describe("one fill is announced once, and history is never replayed", () => {
  it("shows nothing on the first read after launch", () => {
    expect(unshownNotices([row({ id: 9 }), row({ id: 8 })], [], true)).toEqual([]);
  });

  it("shows a row the phone has not put on screen, newest first", () => {
    const fresh = unshownNotices([row({ id: 7 }), row({ id: 11 }), row({ id: 6 })], [6, 7], false);
    expect(fresh.map((r) => r.id)).toEqual([11]);
  });

  it("stays quiet once every row has been shown", () => {
    expect(unshownNotices([row({ id: 12 })], [12], false)).toEqual([]);
  });
});

describe("the read is bounded and costs the broker nothing", () => {
  it("reads the alert route the web desk reads", () => {
    expect(inbox).toContain('client.get<OrderInboxBody>("/v1/alerts/orders")');
    expect(inbox).toContain("queryKey: queryKeys.alerts.orderInbox()");
  });

  it("polls the notice list no faster than the web desk's fallback", () => {
    expect(inbox).toContain("refetchInterval: 30 * 1000");
  });

  it("takes the invalidation stream too, and closes it when the last screen leaves", () => {
    expect(inbox).toContain('if (event === "changed") void queryClient.invalidateQueries({ queryKey: queryKeys.alerts.orderInbox(), exact: true })');
    expect(inbox).toContain("alertStreamUsers += 1");
    expect(inbox).toContain("if (alertStreamUsers === 0 && alertStream) {");
  });

  it("filters live rows in the one place every reader shares", () => {
    expect(inbox).toContain("liveNotices(await client.get<OrderInboxBody>");
    for (const surface of [toast, list, tabs]) expect(surface).not.toContain("mode === \"live\"");
  });
});

describe("the stream keeps the event name this route signals with", () => {
  it("parses event: and defaults to message", () => {
    expect(sse).toContain('let event = "message";');
    expect(sse).toContain('event = line.slice(6).trim() || "message";');
    expect(sse).toContain("onFrame(event, dataLines.join(\"\\n\"))");
  });

  it("keeps the payload-only helper working for the streams that carry a body", () => {
    expect(sse).toContain("export function subscribeSSE(");
    expect(sse).toContain('open(url, (_event, data) => onData(data), onError)');
  });

  it("is exported for the inbox hook and stays out of the public barrel", () => {
    expect(inbox).toContain('import { subscribeSSE, subscribeSSEEvents, type SseSubscription } from "./sse";');
    expect(barrel).toContain("unshownNotices,");
    expect(barrel).not.toContain("subscribeSSEEvents");
  });
});

describe("nothing on the phone may clear the inbox or call itself push", () => {
  it("never reaches the clear route, which would also take paper rows with it", () => {
    expect(inbox).not.toContain("orders/clear");
    expect(toast).not.toContain("orders/clear");
    expect(list).not.toContain("orders/clear");
    expect(orders).not.toContain("orders/clear");
  });

  it("reads a notice rather than scheduling anything", () => {
    expect(inbox).toContain('client.post<void>(`/v1/alerts/orders/${id}/read`, {})');
    expect(toast).not.toContain("expo-notifications");
    expect(list).not.toContain("expo-notifications");
  });
});

describe("the two surfaces point at the same cache", () => {
  it("mounts the toast once, over every screen but the two before a session is open", () => {
    expect(shell).toContain('import OrderNoticeToast from "@/components/OrderNoticeToast";');
    // The shell's own gate, which #37 widened to the unlock screen: a notice about positions belongs to a
    // session the trader has actually entered.
    expect(shell).toContain("{chromeless ? null : <OrderNoticeToast />}");
    expect(shell).not.toContain("<<<<<<<");
  });

  it("lays it over the screen instead of taking a line of it", () => {
    // The banner this replaces sat between the search bar and the router slot, so every route lost the height.
    expect(shell).not.toContain("OrderNoticeBanner");
    expect(toast).toContain('wrap: { position: "absolute", left: 0, right: 0');
    expect(toast).toContain("pointerEvents=\"box-none\"");
  });

  it("leaves the Orders tab unbadged, because a notice now says itself once and stops", () => {
    expect(tabs).not.toContain("tabBarBadge");
    expect(tabs).not.toContain("unreadNotices");
    expect(tabs).not.toContain("useOrderInbox");
  });

  it("lists the notices on the tab the toast opens", () => {
    expect(orders).toContain("<OrderNoticeList />");
    expect(list).toContain("const rows = inbox.data ?? [];");
    expect(list).toContain("if (rows.length === 0) return null;");
  });

  it("opens the orders desk from the toast", () => {
    expect(toast).toContain('router.navigate("/(tabs)/orders")');
  });

  it("retires a toast on a timer and clears that timer when the notice changes", () => {
    expect(toast).toContain("const timer = setTimeout(() => setAnnounced((ids) => [...ids, current.id]), SHOW_MS);");
    expect(toast).toContain("return () => clearTimeout(timer);");
  });

  it("does not mark a notice read just because its toast timed out", () => {
    // Only the tap reaches the read route, so a message the trader may never have looked at cannot silently
    // empty their unread list. The notice stays at the top of the Orders tab until they deal with it.
    expect(toast.match(/markRead\.mutate/g)?.length).toBe(1);
  });

  it("walks a burst of fills one toast at a time, newest first, so none is skipped", () => {
    const three = [row({ id: 21 }), row({ id: 22 }), row({ id: 20 })];
    expect(unshownNotices(three, [], false).map((r) => r.id)).toEqual([22, 21, 20]);
    expect(unshownNotices(three, [22], false).map((r) => r.id)).toEqual([21, 20]);
    expect(unshownNotices(three, [22, 21, 20], false)).toEqual([]);
  });

  it("prints the server's title and summary on each surface, never a sentence written here", () => {
    for (const surface of [toast, list]) {
      expect(surface).toContain("noticeTitle(");
      expect(surface).toContain("noticeSummary(");
    }
    expect(toast).not.toContain('"Order executed');
    expect(list).not.toContain('"Live order');
  });
});
