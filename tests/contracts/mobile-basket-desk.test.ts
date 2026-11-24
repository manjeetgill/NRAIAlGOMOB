import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  basketPnl,
  buildAnalysis,
  closedUnits,
  curves,
  isLiveMoney,
  isLiveRun,
  legValue,
  openLiveBaskets,
  payoffExpiries,
  payoffFigures,
  rupees,
  valueAt,
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
    asOf: "2026-11-24 14:52",
  });
  const built = buildAnalysis(deskBasket({ payoffLegs: [contract()] }), [undated]);
  expect(built.body).not.toBeNull();
  // A local-time string would be a guess about the timezone, so the leg goes without its forward inputs.
  expect(built.body.legs[0].pricedAt).toBeUndefined();
  expect(built.body.legs[0].entrySpot).toBeUndefined();
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
  });
  expect(refused.maxProfit).toContain("cannot resolve");
  expect(refused.pop).toContain("needs a volatility");
  expect(refused.greeks).toContain("out of range");
  expect(Object.values(refused).every(value => value.trim() !== "")).toBe(true);
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
  expect(desk).toContain("no order goes to the broker");
  expect(desk).toContain("Adjust in Builder");
});

it("puts the two tabs on the spread screen and hands the legs to the builder", () => {
  const screen = readFileSync(resolve(root, "apps/mobile/app/spread-builder.tsx"), "utf8");
  expect(screen).toContain('useState<"builder" | "basket">("builder")');
  expect(screen).toContain("<BasketDesk onAdjust={adjustFromBasket} />");
  expect(screen).toContain("row.payoffLegs");
  expect(screen).toContain("nearestStrike(ladder, leg.strike)");
  expect(screen).toContain("does not change or close what the broker already holds");
});
