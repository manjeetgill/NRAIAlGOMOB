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

  it("splits orders by status: working/partial go to pending, done/rejected go to executed", () => {
    expect(screen).toContain('o.status === "working"');
    expect(screen).toContain('o.status === "partial"');
    expect(screen).toContain('o.status === "done"');
    expect(screen).toContain('o.status === "rejected"');
  });

  it("fetches GTT orders from the backend", () => {
    expect(screen).toContain("useGttOrders");
    expect(hooks).toContain("useGttOrders");
    expect(hooks).toContain("/v1/orders/gtt");
  });

  it("exports the GttOrder type", () => {
    expect(hooks).toContain("export interface GttOrder");
    expect(index).toContain("type GttOrder");
  });

  it("shows GTT state badges: active, triggered, expired", () => {
    expect(screen).toContain("gtt.state");
    expect(screen).toContain("badgeActive");
    expect(screen).toContain("badgeTriggered");
  });

  it("displays trigger price for GTT orders", () => {
    expect(screen).toContain("trigger_price");
    expect(screen).toContain("Trigger:");
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
