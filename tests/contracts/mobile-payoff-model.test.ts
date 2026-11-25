/**
 * The phone's option model, tested as arithmetic rather than as a screenshot.
 *
 * The target-date payoff line is drawn by the app, not the server, so these numbers are the ones a
 * trader decides on with nobody else checking them. A factor-of-ten in the volatility unit would
 * render a perfectly shaped curve full of wrong prices — which is why the parity, round-trip and
 * magnitude cases below run on real values instead of on the component's source text.
 */

import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  blackScholes,
  impliedVol,
  normCdf,
} from "../../packages/shared/src/api/payoff-model.ts";

const root = resolve(__dirname, "../..");

/** A NIFTY-like book: 24,000 spot, 20 days, 6.5% carry, 1% dividend. */
const S = 24000;
const T = 20 / 365;
const R = 0.065;
const Q = 0.01;

it("moves the normal curve the way a table of it does", () => {
  expect(normCdf(0)).toBeCloseTo(0.5, 6);
  expect(normCdf(-3)).toBeCloseTo(0.00135, 4);
  expect(normCdf(3)).toBeCloseTo(0.99865, 4);
  expect(normCdf(-1.5)).toBeLessThan(normCdf(1.5));
});

it("leaves only intrinsic when the option has no time or no volatility", () => {
  // The day the position settles, and the flat case a dead IV column produces.
  const dead = blackScholes(24300, 24000, 0, R, Q, 0.2, "CE");
  expect(dead.price).toBeCloseTo(300, 6);
  expect(dead.delta).toBe(1);
  expect(dead.gamma).toBe(0);
  expect(dead.theta).toBe(0);
  expect(dead.vega).toBe(0);
  expect(blackScholes(23700, 24000, 0, R, Q, 0.2, "CE").price).toBe(0);
  expect(blackScholes(23700, 24000, 0, R, Q, 0.2, "PE").price).toBeCloseTo(300, 6);
});

it("holds put-call parity, the check a pricing bug cannot pass by accident", () => {
  const strike = 24000;
  const call = blackScholes(S, strike, T, R, Q, 0.18, "CE").price;
  const put = blackScholes(S, strike, T, R, Q, 0.18, "PE").price;
  // The residual is the 7.5e-8 CDF approximation times a 24,000 notional, so paise rather than rupees.
  expect(call - put).toBeCloseTo(S * Math.exp(-Q * T) - strike * Math.exp(-R * T), 1);
});

it("reads an ATM premium at the magnitude a trader would recognise", () => {
  // 14% IV on a 24,000 strike, 30 days out. The 0.4·S·σ·√T rule of thumb says ~385; carry lifts it.
  // A curve priced with IV left in percent lands near 3,000, so this band is the unit guard itself.
  const atm = blackScholes(24000, 24000, 30 / 365, R, Q, 0.14, "CE").price;
  expect(atm).toBeGreaterThan(400);
  expect(atm).toBeLessThan(480);
  const mistaken = blackScholes(24000, 24000, 30 / 365, R, Q, 14, "CE").price;
  expect(mistaken).toBeGreaterThan(atm * 5);
});

it("solves the volatility a premium implies and hands it straight back", () => {
  for (const strike of [23500, 24000, 24500]) {
    const price = blackScholes(S, strike, T, R, Q, 0.18, "CE").price;
    const solved = impliedVol(price, S, strike, T, R, Q, "CE");
    expect(solved).not.toBeNull();
    expect(solved!).toBeCloseTo(0.18, 4);
    expect(blackScholes(S, strike, T, R, Q, solved!, "CE").price).toBeCloseTo(price, 6);
  }
});

it("refuses to invent volatility for a premium that is only intrinsic", () => {
  // A 23,000 call quoted at its 1,000 of intrinsic carries no vol signal; a solved curve there would
  // be the app's own guess, printed as if the market had said it.
  expect(impliedVol(1000, S, 23000, T, R, Q, "CE")).toBeNull();
  expect(impliedVol(900, S, 23000, T, R, Q, "CE")).toBeNull();
  expect(impliedVol(1100, S, 23000, T, R, Q, "CE")).not.toBeNull();
});

it("decays and reacts the direction a long option does", () => {
  const long = blackScholes(S, S, T, R, Q, 0.18, "CE");
  expect(long.theta).toBeLessThan(0);
  expect(long.vega).toBeGreaterThan(0);
  expect(long.delta).toBeGreaterThan(0.5);
  expect(long.delta).toBeLessThan(1);
  // Further out in time an option carries more value, which is the shape the target line depends on.
  const nearer = blackScholes(S, S, T / 2, R, Q, 0.18, "CE").price;
  const further = blackScholes(S, S, T, R, Q, 0.18, "CE").price;
  expect(further).toBeGreaterThan(nearer);
});

it("draws the target curve from the shared model and says so when the model stays silent", () => {
  const chart = readFileSync(resolve(root, "apps/mobile/src/components/PayoffChart.tsx"), "utf8");
  // One model, in the layer the tests above can reach — a second copy in the component could drift.
  expect(chart).toContain('impliedVol,');
  expect(chart).toContain("from \"@nraialgo/shared/api\"");
  expect(chart).not.toContain("function blackScholes");
  // The ladder quotes IV in percent, so the divide is load-bearing.
  expect(chart).toContain("Number(quote.iv) / 100");
  // A figure only the server can give names its state instead of claiming to still be loading.
  expect(chart).toContain("the model did not answer");
  expect(chart).toContain("figures?.pop ?? modelOnly");
});
