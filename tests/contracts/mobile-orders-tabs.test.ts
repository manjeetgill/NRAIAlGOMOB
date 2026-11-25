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
describe("Orders screen shows three tabs", () => {
  it("has Open, Closed, and GTT Orders tabs", () => {
    expect(screen).toContain('type TabId = "open" | "closed" | "gtt"');
    expect(screen).toContain('{ id: "open", label: "Open" }');
    expect(screen).toContain('{ id: "closed", label: "Closed" }');
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
    /** Anything the collapse does not recognise stays out of both lists instead of being guessed as open. */
    expect(screen).toContain('return "OTHER"');
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
    expect(screen.match(/keyExtractor=\{\(item\) => item\.orderId\}/g) ?? []).toHaveLength(2);
    expect(screen).toContain("keyExtractor={(item) => item.orderId}");
  });

  it("keeps the tab bar mounted when one tab's read fails", () => {
    expect(screen).not.toMatch(/if \(isError\) \{\s*return \(\s*<View style=\{\[styles\.container/);
    expect(screen).toContain("const pane = statusPane();");
    expect(screen).toContain('Failed to load {tab === "gtt" ? "GTT orders" : "orders"}');
  });

  it("refreshes on pull-to-refresh for each tab", () => {
    expect(screen).toContain("RefreshControl");
    expect((screen.match(/<RefreshControl/g) ?? [])).toHaveLength(3);
    expect(screen.match(/onRefresh=\{\(\) => void refetchOrders\(\)\}/g) ?? []).toHaveLength(2);
    expect(screen).toContain("onRefresh={() => void refetchGtts()}");
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
