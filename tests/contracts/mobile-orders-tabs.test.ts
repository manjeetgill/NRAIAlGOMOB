import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const root = resolve(__dirname, "../..");
const screen = readFileSync(resolve(root, "apps/mobile/app/(tabs)/orders.tsx"), "utf8");
const hooks = readFileSync(resolve(root, "packages/shared/src/api/hooks.ts"), "utf8");
const index = readFileSync(resolve(root, "packages/shared/src/api/index.ts"), "utf8");

/**
 * The Orders desk answers with the broker's own list, not with this app's order intents: a trader who placed
 * an order from Breeze must see it here, and an intent this app recorded but the broker refused must not be
 * shown as if it existed. That switch (aa0d05e) also renamed the two status tabs, so the cases below track
 * the list as the ICICI account snapshot actually arrives — one row per broker order, no leg arrays.
 */
describe("Orders screen shows four tabs", () => {
  it("has Open, Closed, All, and GTT Orders tabs", () => {
    expect(screen).toContain('type TabId = "open" | "closed" | "all" | "gtt"');
    expect(screen).toContain('{ id: "open", label: "Open" }');
    expect(screen).toContain('{ id: "closed", label: "Closed" }');
    expect(screen).toContain('{ id: "all", label: "All" }');
    expect(screen).toContain('{ id: "gtt", label: "GTT Orders" }');
    expect(screen).toContain("useState<TabId>(\"open\")");
  });

  it("lists the broker's orders, never this app's own intent log", () => {
    expect(screen).toContain("useIciciAccount");
    expect(screen).toContain("iciciOrders(iciciAccount)");
    expect(hooks).toContain("export function iciciOrders");
    expect(hooks).toContain("payload.sections?.order");
    expect(screen).not.toContain("useOrders");
  });

  it("splits orders by the statuses the broker actually sends", () => {
    // ICICI never sends one word per state: the web desk's normalizeStatus collapses its vocabulary and
    // this screen has to collapse it the same way, or a "TRIGGER PENDING" order lands in neither tab.
    expect(screen).toContain("const s = normalizeStatus(order.status);");
    expect(screen).toContain('if (s === "OPEN") {');
    expect(screen).toContain('s === "COMPLETE" || s === "CANCELLED" || s === "REJECTED"');
    expect(screen).toContain("COMPLETE|COMPLETED|EXECUTED|FILLED|TRADED");
    expect(screen).toContain("OPEN|PENDING|TRIGGER PENDING|ORDERED|REQUESTED|PARTIALLY|PUT ORDER REQ|VALIDATION PENDING|AMO REQ");
    /** Anything the collapse does not recognise is still a broker order: it is kept and shown, not dropped. */
    expect(screen).toContain('return "OTHER"');
    expect(screen).toContain("other.push(order);");
    expect(screen).toContain("if (tab === \"all\") return orderList(allOrders,");
  });

  it("names the state an order is in that neither Open nor Closed covers", () => {
    // A row that vanishes reads as an order the broker never had, which is the opposite of the truth.
    expect(screen).toContain("in a state ICICI words differently");
    expect(screen).toContain("otherOrders.length > 0");
  });

  it("unwraps the {intents:[...]} envelope so the list is never a non-array", () => {
    expect(hooks).toMatch(/\/v1\/orders"[\s\S]{0,200}?response\.intents/);
    expect(hooks).toMatch(/client\.get<\{\s*intents:\s*OrderIntent\[\]\s*\}>/);
  });

  it("fetches GTT orders from the backend", () => {
    expect(screen).toContain("useGttOrders");
    expect(hooks).toContain("useGttOrders");
    expect(hooks).toContain("/v1/orders/gtt");
    expect(hooks).toMatch(/\/v1\/orders\/gtt"[\s\S]{0,200}?response\.gtts/);
  });

  it("exports the GttOrder type", () => {
    expect(hooks).toContain("export interface GttOrder");
    expect(index).toContain("type GttOrder");
  });

  it("badges the GTT states the check constraint allows", () => {
    expect(screen).toContain("gtt.state");
    expect(screen).toContain('gtt.state === "active"');
    expect(screen).toContain('gtt.state === "failed"');
    expect(screen).toContain('gtt.state === "cancelled"');
    expect(hooks).toContain('"requested" | "placing" | "active" | "failed"');
  });

  it("shows GTT trigger and limit prices as numbers, not string blanks", () => {
    expect(screen).toContain("trigger_price");
    expect(screen).toContain("Trigger:");
    expect(screen).toContain("Number(spec?.price)");
    expect(screen).toContain("Number(spec?.quantity)");
  });

  it("shows the server's reason instead of a blank when an order or GTT is unexplained", () => {
    expect(screen).toContain("{order.message ? <Text style={styles.label}>{order.message}</Text> : null}");
    expect(screen).toContain("{gtt.last_error &&");
    expect(screen).toContain("{gtt.last_error}");
    expect(screen).toContain('gtt.state.toUpperCase().replace("_", " ")');
  });

  it("names what the broker filled on every order row", () => {
    // One broker row is one contract, so the identity the old leg array carried is now the order itself:
    // the symbol the broker printed, filled against placed, and the exchange it went out on.
    expect(screen).toContain("{order.symbol || order.orderId}");
    expect(screen).toContain("{order.side} {formatNumber(order.filledQuantity)}/{formatNumber(order.quantity)}");
    expect(screen).toContain("{order.exchange}");
    // Two blank order_ids are one key to a FlatList, and the second order never paints. A blank id is
    // keyed by what else the row carries instead.
    expect(screen).toContain("keyExtractor={orderKey}");
    expect(screen).toContain('order.orderId || `${order.symbol ?? "order"}-${order.timestamp ?? ""}-${index}`');
  });

  it("keeps the tab bar mounted when one tab's read fails", () => {
    expect(screen).not.toMatch(/if \(isError\) \{\s*return \(\s*<View style=\{\[styles\.container/);
    expect(screen).toContain("const pane = statusPane();");
    expect(screen).toContain('Failed to load {tab === "gtt" ? "GTT orders" : "orders"}');
  });

  it("refreshes on pull-to-refresh for each tab", () => {
    // One list helper serves Open, Closed and All, so it carries a single RefreshControl for all three tabs
    // rather than the three copies that used to be written out per branch.
    expect(screen).toContain("RefreshControl");
    expect((screen.match(/<RefreshControl/g) ?? [])).toHaveLength(2);
    expect(screen).toContain("onRefresh={() => { setPulled(true); void refetchOrders(); }}");
    expect(screen).toContain("onRefresh={() => void refetchGtts()}");
  });

  it("shows the refresh it asked for and re-reads when the broker answer lands", () => {
    // GET /v1/broker-auth/icici/account never waits for the broker: it returns the saved snapshot and runs
    // the order-list read behind it, flagged `refreshing`. A pull that fired one GET therefore always
    // showed the previous book, so the spinner has to stay up and the list re-read when that clears.
    expect(screen).toContain("isFetching: ordersFetching");
    expect(screen).toContain("const brokerRead = iciciAccount?.refreshing === true;");
    expect(screen).toContain("refreshing={brokerRead || pulled}");
    expect(screen).toContain("onRefresh={() => { setPulled(true); void refetchOrders(); }}");
    expect(screen).toContain("if (!ordersFetching) setPulled(false);");
    expect(screen).toContain("waitingOnBroker.current = true;");
    expect(screen).toContain("void refetchOrders();");
  });

  it("prints the server's own reason instead of an empty book when the order section is not there", () => {
    expect(screen).toContain('iciciAccountSection(iciciAccount, "order")');
    expect(screen).toContain('ordersState.kind === "unavailable" || ordersState.kind === "cold"');
    expect(screen).toContain("{ordersState.reason ?? \"The broker's order book is not available.\"}");
    expect(screen).toContain("Read ICICI again");
    expect(hooks).toContain('"portfolioholdings" | "portfoliopositions" | "order"');
  });

  it("says whose book the list is and how wide it goes", () => {
    // ICICI's order list is one session, and the exchanges prod asks for have already moved once (NSE/NFO,
    // then BSE/BFO), so the header names the exchanges the rows actually came from rather than a phrase.
    expect(screen).toContain("today's session");
    expect(screen).toContain("seenExchanges.join(\" + \")");
    expect(screen).not.toContain("NSE + NFO`");
    expect(screen).toContain("asOfWord(iciciAccount?.asOf)");
    expect(screen).toContain("no read time printed");
  });

  it("auto-refreshes orders every 10 seconds", () => {
    expect(hooks).toMatch(/refetchInterval:\s*10\s*\*\s*1000/);
  });

  it("says why a row carries no price instead of printing a dash", () => {
    // A market order has no price because none was sent, which is not the same fact as a limit order the
    // broker returned without one. One dash reads as a hole in the data for both.
    expect(screen).toContain("function priceCell(order: BrokerOrder): string");
    expect(screen).toContain("if (order.price) return formatRupees(order.price);");
    expect(screen).toContain('(MARKET|MO)$');
    expect(screen).toContain('"Market price"');
    expect(screen).toContain('"No price sent"');
    expect(screen).toContain("{priceCell(order)}");
    expect(screen).not.toContain('order.price ? formatRupees(order.price) : "—"');
  });
});

describe("The order section's own state, read from prod's answer", () => {
  it.each([
    ["cold", { detail: "Fetching the first broker snapshot." }, "cold", "Fetching the first broker snapshot."],
    ["half-read", { sections: { order: { status: "degraded", reason: "Unavailable broker sections: orders_NFO", rows: [] } } },
      "degraded", "Unavailable broker sections: orders_NFO"],
    ["saved copy", { sections: { order: { status: "available", rows: [] } }, stale: true, staleReason: "Showing last saved broker data." },
      "stale", "Showing last saved broker data."],
    ["never sent", { sections: { funds: { status: "available", rows: [] } } },
      "unavailable", "The broker's answer did not include orders."],
  ])("calls a %s account answer %s with the server's words", async (_name, payload, kind, reason) => {
    const { iciciAccountSection } = await import("../../packages/shared/src/api/hooks.ts");
    expect(iciciAccountSection(payload as never, "order")).toEqual({ kind, reason });
  });

  it("keeps every broker row, including the states the tabs do not name", async () => {
    const { iciciOrders } = await import("../../packages/shared/src/api/hooks.ts");
    const rows = [
      { order_id: "1", status: "Put Order Req", action: "BUY" },
      { order_id: "2", status: "EXPIRED", action: "SELL" },
      { order_id: "", status: "APPROVAL PENDING", action: "BUY" },
    ];
    const orders = iciciOrders({ accountId: "A", sections: { order: { status: "available", rows } } } as never);
    expect(orders).toHaveLength(3);
    expect(orders.map((order: { status: string }) => order.status)).toEqual(["Put Order Req", "EXPIRED", "APPROVAL PENDING"]);
    // The blank id is what used to collapse two rows into one FlatList key; the screen now keys around it.
    expect(orders[2].orderId).toBe("");
  });
});
