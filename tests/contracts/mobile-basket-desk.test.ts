import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  basketPnl,
  buildAnalysis,
  closedUnits,
  curves,
  expiryKey,
  heldPayoff,
  isLiveMoney,
  isLiveRun,
  ladderUnderlying,
  legValue,
  openLiveBaskets,
  payoffExpiries,
  payoffFigures,
  priceProvenance,
  rupees,
  sameContract,
  valueAt,
  withBookMarks,
} from "../../packages/shared/src/api/basket-desk.ts";

const root = resolve(__dirname, "../..");

/** A leg as BasketLegOut sends it: `quantity` is what remains, and the mark arrives without a time. */
function brokerLeg(over: Record<string, unknown> = {}) {
  return {
    instrumentId: "instrument:v1:NSE:FO:NIFTY:CE:2026-11-27:25600:CE",
    symbol: "NIFTY26NOV25600CE",
    exchange: "NSE",
    product: "OPTIONS",
    side: "SELL",
    quantity: 65,
    entryPrice: 96.5,
    exitPrice: null,
    markPrice: 71.05,
    lots: 1,
    lotSize: 65,
    role: "short",
    exited: 0,
    bookedPnl: null,
    pending: false,
    exitSource: null,
    exitAt: null,
    exitNote: null,
    bookedBasis: null,
    ...over,
  };
}

/** A contract as PayoffLeg sends it, which is the only row carrying strike, right and expiry. */
function contract(over: Record<string, unknown> = {}) {
  return {
    instrumentId: "instrument:v1:NSE:FO:NIFTY:CE:2026-11-27:25600:CE",
    underlying: "NIFTY",
    symbol: "NIFTY26NOV25600CE",
    expiry: "2026-11-27",
    strike: "25600",
    right: "CE",
    action: "sell",
    lots: 1,
    lotSize: 65,
    entryPrice: "96.50",
    ...over,
  };
}

function deskBasket(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    name: "NIFTY SHORT STRADDLE",
    kind: "order",
    sourceRef: null,
    underlying: "NIFTY",
    expiry: "2026-11-27",
    spot: 25418.35,
    tau: 0.02,
    legs: [],
    margin: 0,
    account: "9231",
    provider: "icici",
    attribution: "linked by its order",
    realized: 0,
    status: "open",
    working: null,
    tags: [],
    openedAt: "2026-11-24T10:00:00+05:30",
    closedAt: null,
    payoffLegs: [],
    warnings: [],
    charges: null,
    ...over,
  };
}

function ladder(over: Record<string, unknown> = {}) {
  return {
    underlying: "NIFTY",
    expiry: "2026-11-27",
    expiries: ["2026-11-27", "2026-12-01"],
    lotSize: 65,
    spot: { price: "25418.35", quality: "live", at: "2026-11-24T14:52:03+05:30" },
    atTheMoneyStrike: "25600",
    rows: [
      {
        strike: "25600",
        isAtTheMoney: true,
        call: {
          symbol: "NIFTY26NOV25600CE",
          order: null,
          instrumentId: "instrument:v1:NSE:FO:NIFTY:CE:2026-11-27:25600:CE",
          ltp: "96.55",
          bid: "96.40",
          ask: "96.70",
          iv: 0.13,
          delta: 0.48,
          oi: 1200,
          oiChangePct: null,
          volume: 340,
          ltpAt: "2026-11-24T14:52:01+05:30",
          quote: { at: "2026-11-24T14:52:01+05:30", quality: "live" },
        },
        put: null,
      },
      {
        strike: "25200",
        isAtTheMoney: false,
        call: null,
        put: {
          symbol: "NIFTY26NOV25200PE",
          order: null,
          instrumentId: "instrument:v1:NSE:FO:NIFTY:PE:2026-11-27:25200:PE",
          ltp: "88.10",
          bid: "87.90",
          ask: "88.35",
          iv: 0.14,
          delta: -0.42,
          oi: 900,
          oiChangePct: null,
          volume: 210,
          ltpAt: "2026-11-24T14:52:02+05:30",
          quote: { at: "2026-11-24T14:52:02+05:30", quality: "live" },
        },
      },
    ],
    marketOpen: true,
    basis: "ICICI Breeze live",
    provider: "icici",
    asOf: "2026-11-24T14:52:03+05:30",
    ...over,
  };
}

/** A broker open-position row, as the Positions book maps it from ICICI's own columns. */
function bookRow(over: Record<string, unknown> = {}) {
  return {
    symbol: "NIFTY26NOV25600CE",
    side: "SELL",
    quantity: 65,
    entryPrice: 96.5,
    markPrice: 71.05,
    unrealizedPnl: 1654.25,
    broker: "icici",
    account: "9231",
    product: "MIS",
    exchange: "NFO",
    expiry: "2026-11-27",
    strike: "25600",
    right: "CE",
    ...over,
  };
}

it("lists only baskets holding real broker money, and never a closed one", () => {
  const rows = [
    deskBasket({ id: "paper-kind", kind: "paper" }),
    deskBasket({ id: "paper-run", kind: "run", provider: "paper" }),
    deskBasket({ id: "live-run", kind: "run", provider: "icici" }),
    deskBasket({ id: "manual", kind: "manual" }),
    deskBasket({ id: "ticket", kind: "order" }),
    deskBasket({ id: "done", kind: "order", status: "closed" }),
  ];
  // Ordering is the next case's business; here only membership matters, so the comparison ignores it.
  expect(openLiveBaskets(rows).map(basket => basket.id).sort()).toEqual(["live-run", "manual", "ticket"]);
  expect(isLiveMoney(rows[0])).toBe(false);
  expect(isLiveRun(rows[1])).toBe(false);
  expect(isLiveRun(rows[2])).toBe(true);
});

it("sorts the desk by the day the basket was opened, newest first", () => {
  const rows = [
    deskBasket({ id: "old", openedAt: "2026-11-20T09:20:00+05:30" }),
    deskBasket({ id: "new", openedAt: "2026-11-24T09:20:00+05:30" }),
    deskBasket({ id: "undated", openedAt: null }),
  ];
  expect(openLiveBaskets(rows).map(basket => basket.id)).toEqual(["new", "old", "undated"]);
});

it("keeps booked and total present even when the open half has no price", () => {
  const booked = basketPnl([brokerLeg({ quantity: 0, exitPrice: 44, bookedPnl: 2150 })], 2150);
  expect(booked.booked).toBe(2150);
  expect(booked.open).toBeNull();
  expect(booked.total).toBe(2150);

  const blind = basketPnl([brokerLeg({ markPrice: null })], 400);
  expect(blind.unpriced).toBe(1);
  expect(blind.open).toBeNull();
  expect(blind.total).toBe(400);

  const held = basketPnl([brokerLeg({ side: "SELL", markPrice: 71.05, entryPrice: 96.5, quantity: 65 })], 0);
  expect(held.open).toBeCloseTo(1654.25, 2);
  expect(held.total).toBeCloseTo(1654.25, 2);
});

it("prices a bought leg up and a sold leg down, and counts only what is still open", () => {
  const long = basketPnl([brokerLeg({ side: "BUY", quantity: 130, entryPrice: 100, markPrice: 110 })], 0);
  expect(long.open).toBe(1300);
  const closed = basketPnl([brokerLeg({ quantity: 0, markPrice: 999 })], 0);
  expect(closed.open).toBeNull();
  expect(closed.unpriced).toBe(0);
});

it("reads an expiry in every shape the broker sources send", () => {
  expect(expiryKey("2026-11-26")).toBe("2026-11-26");
  expect(expiryKey("20261126")).toBe("2026-11-26");
  expect(expiryKey("26-Nov-2026")).toBe("2026-11-26");
  expect(expiryKey("26 NOV 2026")).toBe("2026-11-26");
  // An ambiguous number-only form is not guessed at; the caller falls back to the broker's own words.
  expect(expiryKey("26-11-2026")).toBeNull();
  expect(expiryKey(null)).toBeNull();
});

it("marks a leg only from the row that is exactly that contract", () => {
  const leg = brokerLeg() as Parameters<typeof sameContract>[1];
  expect(sameContract(bookRow() as Parameters<typeof sameContract>[0], leg)).toBe(true);
  // The same underlying at another strike or right is a different contract: matching on the name alone is
  // how every NIFTY position in the book gets attributed to the newest NIFTY basket.
  expect(sameContract(bookRow({ symbol: "NIFTY26NOV25200PE", strike: "25200", right: "PE" }), leg)).toBe(false);
  expect(sameContract(bookRow({ symbol: "UNAVAILABLE" }), leg)).toBe(false);

  // The other shape: an order token beside a book row whose code embeds the underlying.
  const token = brokerLeg({ symbol: "HINLEV_20261229_2200_PE" }) as Parameters<typeof sameContract>[1];
  expect(sameContract(bookRow({ symbol: "HINLEV26DEC2200PE", strike: "2200", right: "P", expiry: "29-DEC-2026" }), token)).toBe(true);
  expect(sameContract(bookRow({ symbol: "HINLEV26DEC2200CE", strike: "2200", right: "CE", expiry: "2026-12-29" }), token)).toBe(false);
  expect(sameContract(bookRow({ symbol: "HINLEV26NOV2200PE", strike: "2200", right: "PE", expiry: "2026-11-25" }), token)).toBe(false);
  expect(sameContract(bookRow({ symbol: "HINLEV26DEC2250PE", strike: "2250", right: "PE", expiry: "2026-12-29" }), token)).toBe(false);
});

it("fills the marks prod leaves empty on an order or manual basket", () => {
  const held = deskBasket({
    id: "ticket",
    legs: [brokerLeg({ markPrice: null }), brokerLeg({ symbol: "NIFTY26NOV25200PE", strike: "25200", right: "PE", side: "BUY", markPrice: null, entryPrice: 88.1 })],
  });
  const priced = deskBasket({ id: "server-priced", legs: [brokerLeg()] });
  const paper = deskBasket({ id: "paper", kind: "run", provider: "paper", legs: [brokerLeg({ markPrice: null })] });
  const rows = [
    bookRow(),
    bookRow({ symbol: "NIFTY26NOV25200PE", strike: "25200", right: "PE", markPrice: 82.4 }),
  ] as Parameters<typeof withBookMarks>[1];
  const joined = withBookMarks(
    [held, priced, paper] as Parameters<typeof withBookMarks>[0],
    rows,
  );
  expect(joined.marked).toBe(2);
  expect(joined.baskets[0].legs.map(leg => leg.markPrice)).toEqual([71.05, 82.4]);
  // A leg the server already priced keeps the server's number, and a paper basket is never touched.
  expect(joined.baskets[1].legs[0].markPrice).toBe(71.05);
  expect(joined.baskets[2].legs[0].markPrice).toBeNull();
  // The joined card now reports the return the owner decides on, instead of "no price".
  const value = basketPnl(joined.baskets[0].legs, 0);
  expect(value.unpriced).toBe(0);
  expect(value.total).toBeCloseTo((71.05 - 96.5) * 65 * -1 + (82.4 - 88.1) * 65, 2);
});

it("leaves every figure blank when the book holds nothing for the basket", () => {
  const held = [deskBasket({ legs: [brokerLeg({ markPrice: null })] })] as Parameters<typeof withBookMarks>[0];
  const rows = [
    bookRow({ quantity: 0 }),
    bookRow({ markPrice: null }),
    bookRow({ markPrice: 0 }),
  ] as Parameters<typeof withBookMarks>[1];
  const joined = withBookMarks(held, rows);
  expect(joined.marked).toBe(0);
  expect(joined.baskets[0].legs[0].markPrice).toBeNull();
  // No price is not a flat leg: the open half stays null rather than becoming ₹0.00.
  const value = basketPnl(joined.baskets[0].legs, 400);
  expect(value.open).toBeNull();
  expect(value.total).toBe(400);
  expect(value.unpriced).toBe(1);
});

it("asks for one ladder per distinct expiry and no more", () => {
  expect(payoffExpiries(deskBasket({ payoffLegs: [contract(), contract({ right: "PE", strike: "25200" })] })))
    .toEqual(["2026-11-27"]);
  expect(payoffExpiries(deskBasket({
    payoffLegs: [contract(), contract({ expiry: "2026-12-01", strike: "25700" }), contract({ expiry: "2026-11-27" })],
  }))).toEqual(["2026-11-27", "2026-12-01"]);
  expect(payoffExpiries(deskBasket())).toEqual(["2026-11-27"]);
});

it("builds the model body with exactly the keys the server allows", () => {
  const built = buildAnalysis(deskBasket({
    payoffLegs: [contract(), contract({
      instrumentId: "instrument:v1:NSE:FO:NIFTY:PE:2026-11-27:25200:PE",
      symbol: "NIFTY26NOV25200PE",
      strike: "25200",
      right: "PE",
      action: "sell",
      entryPrice: "88.10",
    })],
  }), [ladder()]);
  expect(built.body).not.toBeNull();
  expect(built.unpriced).toEqual([]);
  expect(Object.keys(built.body).sort()).toEqual(["dividend", "legs", "rate", "spot"]);
  expect(Object.keys(built.body.legs[0]).sort())
    .toEqual(["action", "entryPrice", "entrySpot", "exchange", "expiry", "lotSize", "lots", "price", "pricedAt", "right", "strike"]);
  expect(built.body.legs[0].price).toBe("96.55");
  expect(built.body.legs[0].entrySpot).toBe("25418.35");
  expect(built.body.spot).toBe("25418.35");
  expect(built.margin.legs).toHaveLength(2);
  // Every priced leg carries the time and state it was priced in, for the caption under the chart.
  expect(built.marks).toEqual([
    { contract: "NIFTY 25600 CE", priceAt: "2026-11-24T14:52:01+05:30", quality: "live" },
    { contract: "NIFTY 25200 PE", priceAt: "2026-11-24T14:52:02+05:30", quality: "live" },
  ]);
});

it("refuses the model with the leg named, rather than drawing a curve missing a wing", () => {
  const noContracts = buildAnalysis(deskBasket(), [ladder()]);
  expect(noContracts.body).toBeNull();
  expect(noContracts.unpriced.join(" ")).toContain("contracts");

  const noLadder = buildAnalysis(deskBasket({ payoffLegs: [contract()] }), [undefined]);
  expect(noLadder.body).toBeNull();
  expect(noLadder.unpriced).toEqual(["no ladder read for NIFTY yet"]);

  const absentStrike = buildAnalysis(deskBasket({ payoffLegs: [contract({ strike: "26000" })] }), [ladder()]);
  expect(absentStrike.unpriced).toEqual(["NIFTY 26000 CE"]);
});

it("sends a price the model can date, and none it cannot", () => {
  const undated = ladder({
    rows: [{ ...ladder().rows[0], call: { ...ladder().rows[0].call, ltpAt: "2026-11-24 14:52", quote: { at: null, quality: "live" } } }],
    // The ladder's own read time carries a real offset, so it is exactly what a fabricated stamp looks
    // like. The model works each leg's remaining maturity from pricedAt, so borrowing it here would make
    // a trade from last week look like one from this second and lengthen the T+0 line.
    asOf: "2026-11-24T14:52:03+05:30",
  });
  const built = buildAnalysis(deskBasket({ payoffLegs: [contract()] }), [undated]);
  expect(built.body).not.toBeNull();
  // A local-time string would be a guess about the timezone, so the leg goes without its forward inputs.
  expect(built.body.legs[0].pricedAt).toBeUndefined();
  expect(built.body.legs[0].entrySpot).toBeUndefined();
  expect(built.marks[0].priceAt).toBeNull();
});

it("says when the priced legs were priced, in the words the broker used", () => {
  // Nothing dated: the model falls back to the request spot, and the screen has to admit that.
  expect(priceProvenance([{ contract: "NIFTY 25600 CE", priceAt: null, quality: "live" }]))
    .toContain("no leg price carries a time");
  expect(priceProvenance([])).toBe("");

  // An old session is printed with its date, never as a bare clock time that reads as now.
  const lastWeek = priceProvenance([{ contract: "NIFTY 25600 CE", priceAt: "2026-01-05T10:00:00+05:30", quality: "eod" }]);
  expect(lastWeek).toContain("2026-01-05");
  expect(lastWeek).toContain("last close");
  expect(lastWeek).toContain("excludes exit charges");

  // The oldest observation decides the caption: a curve is only as fresh as its stalest wing, and a
  // basket half live and half closing is never printed as if all of it were live.
  const mixed = priceProvenance([
    { contract: "NIFTY 25600 CE", priceAt: new Date().toISOString(), quality: "live" },
    { contract: "NIFTY 25200 PE", priceAt: "2026-01-05T10:00:00+05:30", quality: "eod" },
  ]);
  expect(mixed).toContain("2026-01-05");
  expect(mixed).toContain("mixed prices");
  // One leg dated and one not is counted, not quietly drawn as if both were dated.
  const half = priceProvenance([
    { contract: "NIFTY 25600 CE", priceAt: "2026-01-05T10:00:00+05:30", quality: "live" },
    { contract: "NIFTY 25200 PE", priceAt: null, quality: "live" },
  ]);
  expect(half).toContain("1 leg has no recorded time");
});

it("refuses to draw one index's curve over a basket built on two", () => {
  // /v1/strategy-analysis has no underlying per leg: one spot axis prices everything, so a mixed basket
  // would read as a hedge that moves together when it does not.
  const mixed = buildAnalysis(deskBasket({
    payoffLegs: [contract(), contract({ underlying: "BANKNIFTY", symbol: "BANKNIFTY26NOV56000CE", strike: "56000" })],
  }), [ladder()]);
  expect(mixed.body).toBeNull();
  expect(mixed.unpriced.join(" ")).toContain("one index wide");
  expect(mixed.unpriced.join(" ")).toContain("BANKNIFTY");
});

it("will not ask for margin for a basket wider than the endpoint takes", () => {
  const legs = Array.from({ length: 9 }, (_, index) => contract({ strike: String(25000 + index * 100) }));
  const wide = buildAnalysis(deskBasket({ payoffLegs: legs }), [ladder()]);
  expect(wide.body).toBeNull();
  const eight = buildAnalysis(deskBasket({
    payoffLegs: Array.from({ length: 8 }, (_, index) => contract({ strike: index < 4 ? "25600" : "25200", right: index < 4 ? "CE" : "PE" })),
  }), [ladder()]);
  expect(eight.body).not.toBeNull();
  expect(eight.margin.legs).toHaveLength(8);
});

it("reads the basket's value between the samples, not from the nearest one", () => {
  const spots = [25000, 25200, 25400];
  expect(valueAt(spots, [100, 200, 300], 25300)).toBe(250);
  expect(valueAt(spots, [100, 200, 300], 24000)).toBe(100);
  expect(valueAt(spots, null, 25300)).toBeNull();
  const model = curves({
    spot: "25300",
    curve: { spots, expiry: [100, 200, 300], today: [10, 20, 30] },
  });
  expect(model.atSpot).toBe(250);
  expect(model.atSpotToday).toBe(25);
  expect(curves({ spot: "25300", curve: { spots: [25000, 25200], expiry: [1, 2], today: null } })).toBeNull();
});

it("lifts both model curves by the money the exited units already made", () => {
  const model = curves({
    spot: "25300",
    curve: { spots: [25000, 25200, 25400], expiry: [100, 200, 300], today: [10, 20, 30] },
  }, 1500);
  // Without the shift the chart answers a different question than the Total P&L printed above it.
  expect(model.expiry).toEqual([1600, 1700, 1800]);
  expect(model.today).toEqual([1510, 1520, 1530]);
  expect(model.atSpot).toBe(1750);
  expect(model.atSpotToday).toBe(1525);
});

/**
 * Four baskets run through prod's own settlement engine (`strategy_payoff.payoff_at` and `analyze`, the
 * shipped service, called directly in Python), so the phone's local curve is checked against the same
 * arithmetic the web desk prints rather than against a hand-worked number. Each case probes both sides of
 * every kink, the kink itself, and spots outside the outer strikes.
 */
const SERVER_CURVE = [
  { name: "condor", netDebit: -2140.00, maxProfit: 14640.00, maxLoss: -10360.00,
    breakEvens: [25585.60], unboundedLoss: false, legs: [{ strike: "24500", right: "PE", action: "sell", entryPrice: "95.50", lots: 1, lotSize: 25 }, { strike: "25000", right: "PE", action: "buy", entryPrice: "60.25", lots: 1, lotSize: 25 }, { strike: "25500", right: "CE", action: "sell", entryPrice: "105.75", lots: 1, lotSize: 25 }, { strike: "26000", right: "CE", action: "buy", entryPrice: "55.40", lots: 1, lotSize: 25 }],
    probe: [[23600, 14640], [24499, 14640], [24499.99, 14640], [24500, 14640], [25500, 2140], [25180.55, 2140], [25999, -10335], [26000, -10360], [26000.01, -10360], [26001, -10360], [26600, -10360], [27200, -10360]] },
  { name: "naked_short_ce", netDebit: -2643.75, maxProfit: 2643.75, maxLoss: null,
    breakEvens: [25605.75], unboundedLoss: true, legs: [{ strike: "25500", right: "CE", action: "sell", entryPrice: "105.75", lots: 1, lotSize: 25 }],
    probe: [[24600, 2643.75], [25499, 2643.75], [25500, 2643.75], [25180.55, 2643.75], [25500.01, 2643.5], [25501, 2618.75], [26100, -12356.25], [26700, -27356.25]] },
  { name: "bull_call", netDebit: 3256.25, maxProfit: 14243.75, maxLoss: -3256.25,
    breakEvens: [24630.25], unboundedLoss: false, legs: [{ strike: "24500", right: "CE", action: "buy", entryPrice: "220.35", lots: 1, lotSize: 25 }, { strike: "25200", right: "CE", action: "sell", entryPrice: "90.10", lots: 1, lotSize: 25 }],
    probe: [[23600, -3256.25], [24499, -3256.25], [24499.99, -3256.25], [24500, -3256.25], [25200, 14243.75], [25180.55, 13757.5], [25199, 14218.75], [25200.01, 14243.75], [25800, 14243.75], [26400, 14243.75]] },
  { name: "wide_uneven", netDebit: -825.00, maxProfit: 125825.00, maxLoss: 825.00,
    breakEvens: [], unboundedLoss: false, legs: [{ strike: "20000", right: "PE", action: "sell", entryPrice: "120.00", lots: 1, lotSize: 25 }, { strike: "25000", right: "PE", action: "buy", entryPrice: "45.00", lots: 1, lotSize: 25 }, { strike: "26000", right: "CE", action: "buy", entryPrice: "60.00", lots: 1, lotSize: 25 }, { strike: "31000", right: "CE", action: "sell", entryPrice: "18.00", lots: 1, lotSize: 25 }],
    probe: [[19100, 125825], [19999, 125825], [19999.99, 125825], [20000, 125825], [26000, 825], [25180.55, 825], [30999, 125800], [31000, 125825], [31000.01, 125825], [31600, 125825], [32200, 125825]] },
] as const;

it("draws the held curve exactly where prod's own settlement engine puts it", () => {
  for (const fixture of SERVER_CURVE) {
    const held = heldPayoff(deskBasket({ payoffLegs: fixture.legs.map(leg => contract({ ...leg })) }));
    expect(held, fixture.name).not.toBeNull();
    for (const [spot, value] of fixture.probe) {
      // Inside the drawn range, so the reading is an interpolation of a straight line and not an edge clamp.
      expect(spot).toBeGreaterThanOrEqual(held!.spots[0]!);
      expect(spot).toBeLessThanOrEqual(held!.spots.at(-1)!);
      expect(valueAt(held!.spots, held!.values, spot), `${fixture.name} at ${spot}`).toBeCloseTo(value, 1);
    }
    expect(held!.netDebit, `${fixture.name} net debit`).toBeCloseTo(fixture.netDebit, 2);
    expect(held!.max, `${fixture.name} best`).toBeCloseTo(fixture.maxProfit, 1);
    // A tail still climbing at the edge is unlimited, which is the one case a bare number would lie about.
    if (fixture.unboundedLoss) expect(held!.min).toBeNull();
    else expect(held!.min, `${fixture.name} worst`).toBeCloseTo(fixture.maxLoss!, 1);
    expect(held!.breakEvens.map(Math.round), `${fixture.name} break-evens`).toEqual(fixture.breakEvens.map(Math.round));
    expect(held!.breakEvens.length).toBe(fixture.breakEvens.length);
  }
});

it("declines to draw a held curve it cannot charge, and folds booked money into the one it does", () => {
  // A leg with no recorded premium has an unknown cost basis, so the line would be a guess.
  expect(heldPayoff(deskBasket({ payoffLegs: [contract({ entryPrice: "0" })] }))).toBeNull();
  expect(heldPayoff(deskBasket({ payoffLegs: [contract({ entryPrice: null })] }))).toBeNull();
  expect(heldPayoff(deskBasket())).toBeNull();

  const basket = deskBasket({ payoffLegs: [contract({ strike: "25500", right: "CE", action: "sell", entryPrice: "105.75", lots: 1, lotSize: 25 })] });
  const flat = heldPayoff(basket);
  const booked = heldPayoff(basket, 5000);
  for (const [index, value] of booked.values.entries()) expect(value - 5000).toBeCloseTo(flat.values[index]!, 2);
  // The exited units moved the crossing, exactly as they moved the card's Total P&L.
  expect(booked.breakEvens[0]).toBeCloseTo(flat.breakEvens[0]! + 5000 / 25, 2);
});

it("asks the ladder for the index the contract is listed on, not the broker's own code", () => {
  const withCanonical = deskBasket({ payoffLegs: [contract({ underlying: "NIFTY" })] });
  expect(ladderUnderlying(withCanonical)).toBe("NIFTY");
  // An empty `underlying` is what prod sends for a row keyed by a broker symbol; the name is then the
  // basket's own, which is the string the chain route takes.
  expect(ladderUnderlying(deskBasket({ underlying: "BANKNIFTY", payoffLegs: [contract({ underlying: "" })] }))).toBe("BANKNIFTY");
  expect(ladderUnderlying(deskBasket({ payoffLegs: [contract({ underlying: null })] }))).toBe("NIFTY");
});

it("prints the server's figures, and the server's reason when a figure has none", () => {
  const priced = payoffFigures({
    expiry: {
      available: true, maxProfit: null, maxProfitUnbounded: true, maxLoss: "12820", maxLossUnbounded: false,
      breakevens: ["24902.5", "25896"], netDebit: "-23764", settlement: "2026-11-27",
    },
    pop: { available: true, value: 0.6234, basis: "lognormal move to expiry" },
    greeks: { available: true, delta: -1.2, gamma: 0.00034, theta: -412.5, vega: 88.4, ivPct: 13.4 },
    assumptions: { ratePct: 0, dividendPct: 0 },
  });
  expect(priced.maxProfit).toBe("Unlimited");
  expect(priced.maxLoss).toBe("₹12,820.00");
  expect(priced.pop).toBe("62.34% · lognormal move to expiry");
  expect(priced.net).toBe("Net credit ₹23,764.00");
  expect(priced.breakEvens).toContain("24,902.5");
  // ivPct already arrives multiplied by 100, so a second scaling would print 1340%.
  expect(priced.greeks).toContain("IV 13.4%");
  expect(priced.horizon).toBe("Expires 2026-11-27");

  const refused = payoffFigures({
    expiry: { available: false, reason: "The legs expire on dates the model cannot resolve" },
    pop: { available: false, reason: "POP needs a volatility for every leg" },
    greeks: { available: false, reason: "No greeks for a basket with a leg out of range" },
    assumptions: { ratePct: 0, dividendPct: 0 },
  }, "2026-12-01");
  expect(refused.maxProfit).toContain("cannot resolve");
  expect(refused.pop).toContain("needs a volatility");
  expect(refused.greeks).toContain("out of range");
  // A single-expiry answer carries no settlement date, but the phone drew the curve for a date it read
  // off the legs, so the horizon names it instead of pointing at "the basket's own date".
  expect(refused.horizon).toBe("Expires 2026-12-01");
  expect(Object.values(refused).every(value => value.trim() !== "")).toBe(true);
  // With neither the server nor the legs giving a date, the sentence stays a sentence, never a blank.
  expect(payoffFigures({
    expiry: { available: false, reason: "no limits" },
    pop: { available: false, reason: "no pop" },
    greeks: { available: false, reason: "no greeks" },
    assumptions: { ratePct: 0, dividendPct: 0 },
  }, null).horizon).toBe("Expires at the basket’s own date");
});

it("calls a price by what it is and says whose price an exit was", () => {
  expect(legValue(brokerLeg()).label).toBe("current price");
  expect(legValue(brokerLeg({ pending: true })).label).toBe("order still working");
  expect(legValue(brokerLeg({ quantity: 0, exitPrice: 44, exitSource: "Recorded by you" })))
    .toEqual({ price: 44, label: "you recorded" });
  expect(legValue(brokerLeg({ quantity: 0, exitPrice: 44, exitSource: "Broker trade book" })).label).toBe("broker book");
  expect(closedUnits(brokerLeg({ exited: 85 }))).toBe(85);
  expect(closedUnits(brokerLeg())).toBe(0);
  expect(rupees(-1234.5, true)).toBe("−₹1,234.50");
  expect(rupees(null)).toBeNull();
});

it("asks the routes prod actually serves and never a basket detail one", () => {
  const hooks = readFileSync(resolve(root, "packages/shared/src/api/hooks.ts"), "utf8");
  expect(hooks).toContain('client.get<BasketListResponse>("/v1/baskets"');
  expect(hooks).toContain('client.post<StrategyAnalysis>("/v1/strategy-analysis", body)');
  expect(hooks).toContain('client.post<MarginEstimate>("/v1/planning-margin", body)');
  expect(hooks).toContain("/v1/baskets/${basketId}/close");
  expect(hooks).not.toContain("useBasketDetail");
  expect(hooks).toMatch(/queryKeys\.baskets\.(all|history)[\s\S]{0,400}?invalidateQueries\(\{ queryKey: \["baskets"\] \}\)/);
});

it("keeps the phone honest about what it will not send", () => {
  const desk = readFileSync(resolve(root, "apps/mobile/src/components/BasketDesk.tsx"), "utf8");
  expect(desk).not.toContain("usePlaceOrder");
  expect(desk).not.toContain("useExitLeg");
  expect(desk).toContain("Adjust in Builder");
});

it("prices the desk from the broker book and follows the theme", () => {
  const desk = readFileSync(resolve(root, "apps/mobile/src/components/BasketDesk.tsx"), "utf8");
  expect(desk).toContain("withBookMarks(");
  expect(desk).toContain("useOpenPositions()");
  // The two figures the owner decides on stay on every card, not only in the opened basket.
  expect(desk).toContain("Booked");
  expect(desk).toContain("Total P&amp;L");
  // Where a price came from is stated, and a missing one is named instead of counted as flat.
  expect(desk).toContain("priced from the broker's positions");
  expect(desk).toContain("without a price, not counted");
  // A broker row that reports no spot is not printed as ₹0.00, and the sheet follows the app theme.
  expect(desk).toContain("spot > 0");
  expect(desk).toContain("sheet(resolvedTheme)");
  // A broker-shaped expiry ("26-Nov-2026") is normalised before it prints, not sliced as if it were ISO.
  expect(desk).toContain("expiryKey(value)");
  // A figure that is exactly zero is not drawn in the profit colour.
  expect(desk).toContain("moneyColor(value.booked, styles)");
  expect(desk).not.toContain("booked >= 0 ? styles.cPos");
  expect(desk).not.toContain("const BRAND =");
});

it("puts the two tabs on the spread screen and hands the legs to the builder", () => {
  const screen = readFileSync(resolve(root, "apps/mobile/app/spread-builder.tsx"), "utf8");
  expect(screen).toContain('useState<"builder" | "basket">("builder")');
  expect(screen).toContain("<BasketDesk onAdjust={adjustFromBasket} />");
  expect(screen).toContain("row.payoffLegs");
  // The builder asks the canonical underlying for its ladder, so a broker code ("SENSEX" rows that carry
  // "BSECNXBANK") still finds the chain it needs, and the held strike is staged exactly as the book has it.
  expect(screen).toContain("ladderUnderlying(row)");
  expect(screen).toContain("held: { lots, lotSize: leg.lotSize, entry: leg.entryPrice }");
  // A held contract is not moved to the nearest listed strike: that would send an order for a contract
  // nobody holds, so the strike stays and an off-ladder one is refused by name instead.
  expect(screen).not.toContain("nearestStrike");
});

it("makes every held leg read-only and marks a close instead of deleting the row", () => {
  const screen = readFileSync(resolve(root, "apps/mobile/app/spread-builder.tsx"), "utf8");
  // The held row is text, not a control: no side flip, no right flip, no strike stepper.
  expect(screen).toContain("{leg.held ? (");
  expect(screen).toContain("{`${leg.side} ${leg.strike} ${leg.right}`}");
  // The x marks a close and can be taken back; nothing is sent by that press.
  expect(screen).toContain("onPress={() => (leg.held ? markClose(leg) : remove(leg))}");
  expect(screen).toContain('closingNow ? "arrow-undo" : "close"');
  expect(screen).toContain("struck");
  // A staged basket shows no strategy templates: they would add legs to a book, not build a new one.
  expect(screen).toContain("{adjusting ? null : (");
  expect(screen).toContain("Press x on a leg to close it, then step the lots down to close only part of it; a leg without a mark is left exactly as the broker holds it.");
});

it("closes part of a held leg without pretending the whole leg left", () => {
  const screen = readFileSync(resolve(root, "apps/mobile/app/spread-builder.tsx"), "utf8");
  // A mark defaults to the whole holding and is then stepped, so the count lives with the mark, not the row.
  expect(screen).toContain("useState<Record<string, number>>({})");
  expect(screen).toContain("else next[leg.id] = leg.held?.lots ?? 1;");
  expect(screen).toContain("setMarked(current => ({ ...current, [leg.id]: Math.min(max, Math.max(1, (current[leg.id] ?? max) + direction)) }))");
  // The order line carries the stepped count, and the curve keeps the lots that were not closed.
  expect(screen).toContain("lots: closingNow ? closeLotsOf(leg) : leg.lots,");
  expect(screen).toContain("const left = (leg.held?.lots ?? leg.lots) - closeLotsOf(leg);");
  // The button cannot read as a whole-leg close when it is not one.
  expect(screen).toContain("wholeCloses === closes ? `Close ${closes}` : `Close ${closeLots} lots`");
});

it("sends each leg on its own date and prices it off that date's chain", () => {
  const screen = readFileSync(resolve(root, "apps/mobile/app/spread-builder.tsx"), "utf8");
  // A held leg is staged with the expiry the broker bought it on, and a basket spanning dates is staged
  // rather than sent back to the web desk.
  expect(screen).toContain("expiry: leg.expiry,");
  expect(screen).toContain("const dates = [...new Set(contracts.map(leg => leg.expiry))].sort();");
  expect(screen).not.toContain("a calendar basket is worked from the web desk");
  // The draft line names the leg's own date: one press can close one date and add another.
  expect(screen).toContain("expiry: line.expiry,");
  // Prices, lot sizes and the strike stepper come off the ladder the leg actually lives on, read by
  // useOptionChains so a date that is not on screen never borrows this one's premium.
  expect(screen).toContain("const extra = useOptionChains(underlying, offDates, offDates.length > 0);");
  expect(screen).toContain("const read = chainOf.get(leg.expiry);");
  // The date is part of what would be sent, so it is part of the reference key: tapping the strip above
  // can no longer re-aim every contract under a reference that named the old ones.
  expect(screen).toContain('["hold", leg.expiry, leg.strike, leg.right, leg.side, closeLotsOf(leg)]');
  // An unpriced line names the date it could not be priced on, and stops the whole press.
  expect(screen).toContain("${unpriced.strike} ${unpriced.right} ${unpriced.expiry} has no price from the broker.");
});

it("shows the bid, the ask and the exact price each leg is placed at", () => {
  const screen = readFileSync(resolve(root, "apps/mobile/app/spread-builder.tsx"), "utf8");
  // Both sides of the book for the leg's own date, so the placed price is visibly sitting inside a spread.
  expect(screen).toContain("function bookOf(chain: OptionChainData | undefined, strike: string, right: \"CE\" | \"PE\")");
  expect(screen).toContain("<Text style={styles.bid}>{price(twoSided.bid)}</Text>");
  expect(screen).toContain("<Text style={styles.ask}>{price(twoSided.ask)}</Text>");
  // The limit price is named with the side it was taken from.
  expect(screen).toContain("return read ? legQuote(read, leg.strike, leg.right, side) : null;");
  expect(screen).toContain('const order: Array<["bid" | "ask" | "ltp", string | null]> = side === "BUY"');
});

it("sends only the marked closes and the new legs, never the rest of the book", () => {
  const screen = readFileSync(resolve(root, "apps/mobile/app/spread-builder.tsx"), "utf8");
  // An unmarked held leg contributes no order line at all.
  expect(screen).toContain("if (leg.held && !closingNow) return [];");
  // The close takes the opposite side of what is held, at the held leg's own lot size.
  expect(screen).toContain('const side = closingNow ? (leg.side === "BUY" ? "SELL" : "BUY") : leg.side;');
  expect(screen).toContain("const sizeOf = (leg: Leg) => leg.held?.lotSize || chainOf.get(leg.expiry)?.lotSize || lotSize;");
  expect(screen).toContain('kind: leg.held ? "close" : "add",');
  // The button names what the press will do, and an unpriced line stops the whole send.
  expect(screen).toContain('[closeText, adds ? `Add ${adds}` : ""].filter(Boolean).join("  ·  ")');
  expect(screen).toContain("has no price from the broker. Nothing was sent.");
  expect(screen).toContain("The broker still holds every leg of this basket.");
});

it("re-targets unexecuted legs and refreshes payoff when trader taps another expiry chip", () => {
  const screen = readFileSync(resolve(root, "apps/mobile/app/spread-builder.tsx"), "utf8");
  expect(screen).toContain("const switchExpiry = (targetDay: string) => {");
  expect(screen).toContain("onPress={() => switchExpiry(day)}");
  // Does not re-target held legs from the broker
  expect(screen).toContain("if (item.held) return item;");
  // Matches templates to re-anchor strikes cleanly on the new date
  expect(screen).toContain("const templateMatch = TEMPLATES.find(");
  expect(screen).toContain("expiry: targetDay,");
});

it("asks for a basket name at Execute and sends every order under it", () => {
  const screen = readFileSync(resolve(root, "apps/mobile/app/spread-builder.tsx"), "utf8");
  // Execute opens the naming sheet; only the sheet's Send talks to prod.
  expect(screen).toContain("onPress={ask}");
  expect(screen).toContain("setSendSheet(true);");
  // An adjustment of a basket the desk already names shows a confirmation modal before sending; clearing the
  // name is the one case that brings the prompt back.
  expect(screen).toContain("if (adjusting && basket.trim()) { setConfirmExecute(true); return; }");
  expect(screen).toContain("Execute adjustment?");
  // A basket that cannot go out never gets a sheet: the same refusals run before it opens.
  expect(screen).toContain("const reason = refusal();\n    if (reason) { setNote(reason); return; }");
  // The name is always sent, so the intent is never an anonymous one the desk cannot file.
  expect(screen).toContain("basketName: name,");
  expect(screen).not.toContain("...(basket.trim() ? { basketName: basket.trim() } : {})");
  // Clearing the name stops the press instead of silently filing the basket under nothing.
  expect(screen).toContain('if (!name) { setSendSheet(false); setNote("Name the basket before sending. Nothing was sent."); return; }');
  // Every basket is nameable, not only a multi-leg one.
  expect(screen).not.toContain("{legs.length > 1 ? (");
  // An adjusted basket is filed back onto its own card, and a symbol switch drops the old name.
  expect(screen).toContain("if (basket.trim()) return basket.trim();");
  expect(screen).toContain('setBasket("");');
});

it("ticks open legs from the price socket and leaves the rest on the read's mark", async () => {
  const { withStreamMarks, basketStreamIds } = await import("../../packages/shared/src/api/basket-desk.ts");
  const id = "instrument:v1:NSE:FO:NIFTY:CE:2026-11-27:25600:CE";
  const basket = {
    id: "b1", provider: "icici",
    legs: [
      { ...brokerLeg(), instrumentId: id, quantity: 65, markPrice: 100 },
      { ...brokerLeg(), instrumentId: "NIFTY25NOV25600PE", quantity: 65, markPrice: 50 },
      { ...brokerLeg(), instrumentId: "instrument:v1:NSE:FO:NIFTY:PE:2026-11-27:25500:PE", quantity: 0, markPrice: 40 },
    ],
  } as never;
  expect(basketStreamIds([basket])).toEqual([id]);
  const tick = (over: Record<string, unknown>) => ({ id, price: 112.5, at: null, fresh: true, status: "LIVE", source: "icici",
    broker: "icici", subscriptionId: "s", ...over }) as never;
  const [live] = withStreamMarks([basket], [tick({})]) as Array<{ legs: Array<{ markPrice: number }> }>;
  expect(live.legs.map(leg => leg.markPrice)).toEqual([112.5, 50, 40]);
  // A tick the server does not call fresh never replaces the read's mark.
  const [stale] = withStreamMarks([basket], [tick({ fresh: false })]) as Array<{ legs: Array<{ markPrice: number }> }>;
  expect(stale.legs[0].markPrice).toBe(100);
  expect(basketStreamIds([{ ...(basket as object), provider: "paper" } as never])).toEqual([]);
});
