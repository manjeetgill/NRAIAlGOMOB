import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const root = resolve(__dirname, "../..");
const screen = readFileSync(resolve(root, "apps/mobile/app/(tabs)/orders.tsx"), "utf8");
const hooks = readFileSync(resolve(root, "packages/shared/src/api/hooks.ts"), "utf8");
const index = readFileSync(resolve(root, "packages/shared/src/api/index.ts"), "utf8");

describe("Orders screen shows three tabs", () => {
  it("has Pending, Executed, and GTT Orders tabs", () => {
    expect(screen).toContain('"pending"');
    expect(screen).toContain('"executed"');
    expect(screen).toContain('"gtt"');
    expect(screen).toContain("Pending");
    expect(screen).toContain("Executed");
    expect(screen).toContain("GTT Orders");
  });

  it("splits orders by the statuses the server actually returns", () => {
    expect(screen).toContain('o.status === "queued"');
    expect(screen).toContain('o.status === "working"');
    expect(screen).toContain('o.status === "unknown"');
    expect(screen).toContain('o.status === "filled"');
    expect(screen).toContain('o.status === "partial"');
    expect(screen).toContain('o.status === "cancelled"');
    expect(screen).toContain('o.status === "failed"');
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

  it("shows the server's reason instead of a blank when a leg or GTT is unexplained", () => {
    expect(screen).toContain("leg.state.toUpperCase()");
    expect(screen).toContain("intent.message");
    expect(screen).toContain("gtt.last_error");
  });

  it("refreshes on pull-to-refresh for each tab", () => {
    expect(screen).toContain("RefreshControl");
    expect(screen).toContain("refetchIntents");
    expect(screen).toContain("refetchGtts");
  });

  it("auto-refreshes orders every 10 seconds", () => {
    expect(hooks).toMatch(/refetchInterval:\s*10\s*\*\s*1000/);
  });
});
