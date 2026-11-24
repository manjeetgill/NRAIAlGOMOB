import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const root = resolve(__dirname, "../..");
const screen = readFileSync(resolve(root, "apps/mobile/app/algo-lab/[detail].tsx"), "utf8");
const list = readFileSync(resolve(root, "apps/mobile/app/algo-lab.tsx"), "utf8");
const hooks = readFileSync(resolve(root, "packages/shared/src/api/hooks.ts"), "utf8");
const index = readFileSync(resolve(root, "packages/shared/src/api/index.ts"), "utf8");

describe("Algo Lab detail opens from both lists", () => {
  it("routes a running algo and a saved strategy into the same detail screen", () => {
    expect(list).toContain('source=run');
    expect(list).toContain('source=draft');
    expect(list).toContain("/algo-lab/detail?");
  });

  it("carries three tabs so payoff, settings and controls all reach the phone", () => {
    expect(screen).toContain('id: "payoff"');
    expect(screen).toContain('id: "settings"');
    expect(screen).toContain('id: "actions"');
    expect(screen).toContain("Payoff");
    expect(screen).toContain("Settings");
    expect(screen).toContain("Actions");
  });
});

describe("Payoff tab prices from the shared server", () => {
  it("reuses the web strategy-analysis curve and figure helpers", () => {
    expect(screen).toContain("curves");
    expect(screen).toContain("payoffFigures");
    expect(screen).toContain("useStrategyAnalysis");
    expect(screen).toContain("Priced by the same server the web desk uses");
  });

  it("draws the touch read-off from the same expiry curve, never a second source", () => {
    expect(screen).toContain("touchValue");
    expect(screen).toMatch(/expiryY\[next\]/);
  });
});

describe("Start live stays double-gated", () => {
  it("needs an explicit acknowledgement before authorizing real orders", () => {
    expect(screen).toContain("authorize real broker orders");
    expect(screen).toMatch(/!ack/);
    expect(screen).toMatch(/disabled=\{!gateOpen \|\| !ack/);
  });

  it("sends the live-mode start body the backend contract requires", () => {
    expect(screen).toMatch(/mode:\s*"live"/);
    expect(screen).toMatch(/acknowledge:\s*true/);
    expect(screen).toMatch(/draftVersion:\s*detail\.updatedAt/);
    expect(screen).toContain("requestId: newClientId()");
  });

  it("re-checks the server gates and warns acceptance is not a fill", () => {
    expect(screen).toContain("Nothing is sent until the gates are open");
    expect(screen).toContain("Acceptance is not a confirmed fill");
  });
});

describe("Settings edits the saved copy, never a live run", () => {
  it("keeps a running algo's managed rules read-only", () => {
    expect(screen).toContain("Managed rules (read-only)");
    expect(screen).toContain("nothing here can alter what the engine does next");
  });

  it("saves through the copy write path with the optimistic-lock version", () => {
    expect(screen).toMatch(/updateCopy\.mutateAsync\(\{\s*copyId,\s*body:\s*\{\s*draftVersion:\s*draft\.data\.updatedAt/);
    expect(hooks).toMatch(/client\.put<StrategyDraftSummary>\(`\/v1\/strategy-copies\/\$\{encodeURIComponent\(copyId\)\}`,\s*body,\s*\{\s*headers:\s*\{\s*"X-Algo-Lab":\s*"1"\s*\}\s*\}/);
  });

  it("tells the trader a save places no order and a conflict needs a reload", () => {
    expect(screen).toContain("Editing these does not place, change or close any live order");
    expect(screen).toContain("Reload it before editing again");
  });

  it("merges edited keys into the full config so unknown knobs survive the write", () => {
    expect(screen).toMatch(/const merged: Record<string, unknown> = \{ \.\.\.config \}/);
  });
});

describe("Stop and close is confirm-gated and honest", () => {
  it("warns that closing places real broker orders", () => {
    expect(screen).toContain("Closing sends real broker orders");
  });

  it("routes the stop through a confirmation modal before closing", () => {
    expect(screen).toContain("Stop and close?");
    expect(screen).toContain("Confirm stop");
    expect(screen).toMatch(/onPress=\{\(\) => setConfirmStop\(true\)\}/);
    expect(hooks).toMatch(/client\.post<\{ status: string \}>\(`\/v1\/algo-lab\/engine\/\$\{encodeURIComponent\(runId\)\}\/close`/);
  });
});

describe("Shared API exposes the detail read and copy write", () => {
  it("reads the draft detail envelope", () => {
    expect(hooks).toContain("useDraftDetail");
    expect(hooks).toMatch(/client\.get<DraftDetail>\(`\/v1\/strategy-drafts\/\$\{encodeURIComponent\(id as string\)\}`/);
  });

  it("re-exports the detail types and hooks", () => {
    expect(index).toContain("type DraftDetail");
    expect(index).toContain("type ManagedBasketLeg");
    expect(hooks).toMatch(/\n\s+useDraftDetail,/);
    expect(hooks).toMatch(/\n\s+useUpdateCopy,/);
  });

  it("invalidates the draft detail after a copy write so the screen refetches the new version", () => {
    expect(hooks).toMatch(/useUpdateCopy[\s\S]{0,600}?invalidateQueries\(\{\s*queryKey: queryKeys\.algoLab\.draftDetail\(copyId\)\s*\}\)/);
  });
});
