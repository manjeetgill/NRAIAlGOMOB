import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { limitPlaceholder, typedLimit } from "../../packages/shared/src/api/leg-limit.ts";

const root = resolve(__dirname, "../..");
const screen = readFileSync(resolve(root, "apps/mobile/app/spread-builder.tsx"), "utf8");
const index = readFileSync(resolve(root, "packages/shared/src/api/index.ts"), "utf8");

/**
 * A price the trader types, rather than the one the book is leaving at.
 *
 * The builder priced every line off the broker's own book, so the only limit order this screen could send
 * was one the market chose. A box per leg makes the number the trader's, which is what a limit is for - and
 * because the same press can carry a close of something held, the box has to survive the walk from the
 * staged leg to `plan`, to the draft line, to the review sheet, with nothing between them substituting a
 * book figure for the typed one.
 */

describe("A typed price is the number prod is sent", () => {
  it("reads a whole rupee figure", () => {
    expect(typedLimit("95")).toBe(95);
    expect(typedLimit(" 96.5 ")).toBe(96.5);
    expect(typedLimit("1250")).toBe(1250);
  });

  it("keeps a half-typed keystroke working", () => {
    // A field that rewrote "12." to "12.00" under the finger could not be typed in at all.
    expect(typedLimit("12.")).toBe(12);
    expect(typedLimit("12.3")).toBe(12.3);
  });

  it("rounds to the two decimals the order model stores", () => {
    // `OrderIn.price` is a Decimal(decimal_places=2), so a third decimal is a number prod never holds.
    expect(typedLimit("96.456")).toBe(96.46);
    expect(typedLimit("0.005")).toBe(0.01);
  });

  it("answers null for anything that is not a price above zero", () => {
    expect(typedLimit("")).toBeNull();
    expect(typedLimit("   ")).toBeNull();
    expect(typedLimit(undefined)).toBeNull();
    expect(typedLimit("0")).toBeNull();
    expect(typedLimit("0.00")).toBeNull();
    expect(typedLimit("-5")).toBeNull();
    expect(typedLimit("1e3")).toBeNull();
    expect(typedLimit("12,50")).toBeNull();
    expect(typedLimit("abc")).toBeNull();
  });

  it("offers the book figure as the price that goes out untouched", () => {
    expect(limitPlaceholder(96.5)).toBe("96.50");
    expect(limitPlaceholder(null)).toBe("");
    expect(limitPlaceholder(undefined)).toBe("");
    // A book figure of zero is not a price, so the box must not promise to send it.
    expect(limitPlaceholder(0)).toBe("");
  });
});

describe("Every leg that sends a line carries its own box", () => {
  it("sends the typed number on the plan line", () => {
    expect(screen).toContain("const priceOf = (leg: Leg, side: \"BUY\" | \"SELL\") => typedLimit(leg.limit) ?? quoteOf(leg, side)?.price ?? null;");
    expect(screen).toContain("price: priceOf(leg, side),");
  });

  it("prices the payoff curve and the net figure off the same number", () => {
    // The curve the trader judges the basket by and the rupee figure on the button must be the basket they
    // are about to send, so neither may read the book once a price has been chosen.
    expect(screen).toContain("const premium = leg.held ? amount(leg.held.entry) : priceOf(leg, leg.side);");
    expect(screen).toMatch(/const net = plan\.reduce\(\(sum, line\) =>[\s\S]*?line\.price === null/);
  });

  it("gives a close of a held leg a box too", () => {
    const closing = screen.slice(screen.indexOf("const markClose"), screen.indexOf("const setCloseLots"));
    expect(closing).toContain("closing.includes(leg.id) ? { ...item, limit: \"\" } : item");
    // An unmarked held leg sends no order, so it gets no price: a number typed against nothing would be a
    // price for an instruction this press does not place.
    expect(screen).toContain("const sendable = !leg.held || closingNow;");
    expect(screen).toContain("{sendable ? (");
  });

  it("empties the box when the press moves to a different contract", () => {
    // 95 for the 24000 CE says nothing about the 24100 CE, the PE, or the same strike next month.
    expect(screen).toContain("return { ...item, strike: ladder[next], limit: \"\" };");
    expect(screen).toContain("{ ...item, limit: \"\", [field]: field === \"side\"");
    expect(screen).toContain("return { ...item, expiry: targetDay, strike: newStrike, limit: \"\" };");
    expect(screen).toContain("{ ...item, expiry: day, limit: \"\" }");
  });

  it("keeps a chosen price in the instruction's own reference", () => {
    // Two presses at two prices are two instructions: reusing the first reference would let prod dedupe
    // the second, and the trader would watch an order that never left.
    expect(screen).toMatch(/\["hold", leg\.expiry, leg\.strike, leg\.right, leg\.side, closeLotsOf\(leg\), leg\.limit \?\? ""\]/);
    expect(screen).toMatch(/\[leg\.expiry, leg\.side, leg\.right, String\(leg\.strike\), leg\.lots, leg\.limit \?\? ""\]/);
  });

  it("refuses the press on a box that holds no price", () => {
    // Falling back to the book here would send a number the trader never saw on the row they pressed.
    const refusal = screen.slice(screen.indexOf("const refusal"), screen.indexOf("const refusal") + 2000);
    expect(refusal).toContain("typedLimit(leg.limit) === null");
    expect(refusal).toContain("which is not a price above zero. Empty the box to send at the book. Nothing was sent.");
  });

  it("takes the keystrokes as they come and keeps them for the review sheet", () => {
    expect(screen).toContain("onChangeText={text => setLimit(leg, text)}");
    expect(screen).toContain("keyboardType=\"decimal-pad\"");
    expect(screen).toContain("placeholder={limitPlaceholder(quote?.price ?? null)}");
    // The confirm sheet already prints each line's own price, so the typed number is what gets reviewed.
    expect(screen).toContain("{`${line.lots} lot${line.lots > 1 ? \"s\" : \"\"} ${underlying} ${line.strike} ${line.right} (${line.expiry}) · ${line.price !== null ? `₹${formatNumber(line.price, 2)}` : \"Market\"}`}");
  });

  it("writes nothing to the broker from a keystroke", () => {
    // The price box is staging, exactly like the steppers: only Execute sends, and it sends once.
    const setLimit = screen.slice(screen.indexOf("const setLimit"), screen.indexOf("const markClose"));
    expect(setLimit).not.toMatch(/placeOrder|createDrafts|mutate\(/);
    expect(screen).toMatch(/const setLimit = \(leg: Leg, text: string\) =>\s*edit\(current => current\.map\(item => item\.id === leg\.id \? \{ \.\.\.item, limit: text \} : item\)\);/);
  });

  it("is handed to the screens through the shared barrel", () => {
    expect(index).toMatch(/export \{\s*limitPlaceholder,\s*typedLimit,\s*\} from "\.\/leg-limit";/);
  });
});
