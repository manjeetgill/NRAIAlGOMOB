/**
 * TanStack Query Hooks - Shared data fetching for web and mobile
 *
 * Provides typed hooks for all /v1/* endpoints
 * Uses the shared ApiClient for consistent behavior
 */

import { useQuery, useQueries, useMutation, useQueryClient, keepPreviousData, UseQueryOptions, UseMutationOptions, QueryClient } from "@tanstack/react-query";
import { createApiClient, ApiClient, ApiError } from "./client";
import { formatISTDate } from "../utils";

/** The server's own ceiling, documented as "comfortably the whole ladder", so a read never hides strikes. */
const FULL_WINDOW = 400;

/**
 * Leg states prod still moves on. Anything else is where the basket landed, so a screen following one
 * instruction can stop asking without guessing at a finish.
 */
const UNSETTLED_LEG_STATES = new Set(["queued", "dispatching", "acknowledged", "unknown", "partially_filled"]);

// Query params type - TanStack Query expects string | number | boolean values
export type QueryParams = Record<string, string | number | boolean | null | undefined>;

// Query key factory for consistent cache keys
export const queryKeys = {
  // Auth
  auth: {
    me: () => ["auth", "me"] as const,
    brokers: () => ["auth", "brokers"] as const,
  },

  // Baskets. Prod serves the whole desk from GET /v1/baskets - there is no single-basket read, so a
  // write invalidates the list it came from rather than a detail key nothing can fetch.
  baskets: {
    all: (source?: string) => ["baskets", source ?? "all"] as const,
    history: (params?: QueryParams) => ["baskets", "history", params] as const,
  },

  // Positions
  positions: {
    open: (broker?: string) => ["positions", "open", broker ?? "all"] as const,
    closed: (params?: QueryParams) => ["positions", "closed", params] as const,
  },

  // The whole ICICI account response: funds, holdings and positions arrive in one body, so the
  // Portfolio screen reads its state from this key while the rows keep their own.
  brokerAccount: {
    icici: () => ["broker-account", "icici"] as const,
  },

  // Watchlist
  watchlist: {
    list: (number: number) => ["watchlist", "list", number] as const,
    builtin: (name: string, page: number) => ["watchlist", "builtin", name, page] as const,
    search: (query: string) => ["watchlist", "search", query] as const,
  },

  // Option Chain
  optionChain: {
    chain: (underlying: string, expiry: string) => ["option-chain", "chain", underlying, expiry || "auto"] as const,
    underlyings: () => ["option-chain", "underlyings"] as const,
    // The analysis body is the key: the server answers a POST, and two different baskets must never
    // share one cached curve.
    analysis: (body: StrategyAnalysisRequest) => ["option-chain", "analysis", body] as const,
    margin: (body: MarginRequest) => ["option-chain", "margin", body] as const,
  },

  // Orders
  orders: {
    intents: (params?: QueryParams) => ["orders", "intents", params] as const,
    live: ["orders", "live"] as const,
    ticket: (symbol: string) => ["orders", "ticket", symbol] as const,
    quote: (exchange: string, symbol: string) => ["orders", "quote", exchange, symbol] as const,
    destinations: () => ["orders", "destinations"] as const,
    snapshot: (clientId: string) => ["orders", "snapshot", clientId] as const,
    gtt: () => ["orders", "gtt"] as const,
  },

  // Market Data
  market: {
    quotes: (symbols: string[]) => ["market", "quotes", symbols.sort().join(",")] as const,
    indices: () => ["market", "indices"] as const,
    depth: (symbol: string) => ["market", "depth", symbol] as const,
  },

  // Scanner/Automations
  scanner: {
    automations: () => ["scanner", "automations"] as const,
    liveTrades: () => ["scanner", "live-trades"] as const,
    results: (params?: QueryParams) => ["scanner", "results", params] as const,
  },

  // Algo Lab
  algoLab: {
    fleet: () => ["algo-lab", "fleet"] as const,
    drafts: () => ["algo-lab", "drafts"] as const,
    strategies: (params?: QueryParams) => ["algo-lab", "strategies", params] as const,
  },

  // Terminal
  terminal: {
    chart: (symbol: string, interval: string) => ["terminal", "chart", symbol, interval] as const,
  },

  // History
  history: {
    all: (params?: QueryParams) => ["history", "all", params] as const,
  },
} as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today in the exchange's own calendar, whichever timezone the device happens to sit in. */
export const todayIST = (): string => formatISTDate(new Date());

/**
 * The listed contract that closes out the nearest month, which is the one a desk opens on. Weeklies
 * are listed earlier in their own month, so the last date of a month is that month's monthly — the
 * same rule the web desk prints "Monthly" under. Empty when nothing on the ladder is still live.
 */
export function nearestMonthlyExpiry(expiries: readonly string[], today: string): string {
  const live = expiries.filter(iso => ISO_DATE.test(iso) && iso >= today).sort();
  const lastOfMonth = new Map<string, string>();
  for (const iso of live) lastOfMonth.set(iso.slice(0, 7), iso); // `live` ascends, so a month's last write wins
  return live.find(iso => lastOfMonth.get(iso.slice(0, 7)) === iso) ?? "";
}

const DAILY_INTERVALS = new Set(["1d", "1w", "1M"]);
// SENSEX and BANKEX options are listed on BSE's derivatives segment; every other underlying is NSE.
const BSE_UNDERLYINGS = new Set(["SENSEX", "BANKEX"]);
const CHART_KEY = /^(NSE|BSE|NFO|BFO|MCX|CDS):/;

/** The instrument key the chart routes expect: an exchange prefix, never a bare symbol. */
export function chartInstrument(name: string): string {
  const symbol = (name || "").trim().toUpperCase();
  if (!symbol) return "";
  if (CHART_KEY.test(symbol)) return symbol;
  return `${BSE_UNDERLYINGS.has(symbol) ? "BSE" : "NSE"}:${symbol}`;
}

/**
 * Daily and weekly candles live on the history route; minutes and hours on the intraday route.
 * Asking either one for the other's interval is a 422, which is why a chart can fail without the
 * symbol being wrong.
 */
export function chartRequest(instrument: string, interval: string): { path: string; params: { instrument: string; interval: string } } {
  return {
    path: DAILY_INTERVALS.has(interval) ? "/v1/charts/history" : "/v1/charts/intraday",
    params: { instrument, interval },
  };
}

/** Prod puts its reason in `detail`; a status line alone leaves the trader with a blank that is not a blank. */
export function chartFailureReason(error: unknown, fallback = "The chart could not be loaded."): string {
  const detail = (error as { details?: unknown } | null)?.details;
  if (detail && typeof detail === "object") {
    const message = (detail as { detail?: unknown }).detail;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  const message = (error as Error | null)?.message;
  return message && !/^HTTP \d{3}/.test(message) ? message : fallback;
}

/**
 * The symbol picker's two groups, narrowed by whatever the trader typed. A group with no rows is left
 * out entirely, so the list never shows a heading sitting over nothing.
 */
export function chartPickerSections(
  items: readonly UnderlyingInfo[],
  search: string,
): { title: string; data: UnderlyingInfo[] }[] {
  const needle = search.trim().toUpperCase();
  const matches = (item: UnderlyingInfo) => !needle || item.name.includes(needle);
  return [
    { title: "Indices", data: items.filter((item) => item.index && matches(item)) },
    { title: "F&O stocks", data: items.filter((item) => !item.index && matches(item)) },
  ].filter((section) => section.data.length > 0);
}

// Hook factory for creating typed API hooks
/** The caller's own query client is required: the cache operations in these hooks run outside React, so
 *  whatever is passed here is the only cache they can reach. A client invented here would leave every
 *  invalidation and the logout clear landing on a cache no screen reads. */
export function createApiHooks(client: ApiClient, queryClient: QueryClient) {
  const qc = queryClient;

  // ===== AUTH =====
  const useMe = (options?: UseQueryOptions<User, ApiError>) => {
    return useQuery({
      queryKey: queryKeys.auth.me(),
      queryFn: () => client.get<User>("/v1/auth/me"),
      staleTime: 5 * 60 * 1000,
      ...options,
    });
  };

  const useBrokers = (options?: UseQueryOptions<BrokerStatus[], ApiError>) => {
    return useQuery({
      queryKey: queryKeys.auth.brokers(),
      queryFn: () => client.get<BrokerStatus[]>("/v1/auth/brokers"),
      staleTime: 30 * 1000,
      ...options,
    });
  };

  const useLogin = (options?: UseMutationOptions<LoginResponse, ApiError, LoginRequest>) => {
    return useMutation({
      mutationFn: (body) => client.post<LoginResponse>("/v1/auth/login", body),
      ...options,
    });
  };

  // The options used to be spread after onSuccess, so a caller that passed its own callback — to navigate
  // away after signing out — replaced the cache clear outright and the last account's holdings and orders
  // stayed readable on a phone someone else picks up.
  const useLogout = (options?: UseMutationOptions<void, ApiError, void>) => {
    const { onSuccess, ...rest } = options ?? {};
    return useMutation({
      ...rest,
      mutationFn: () => client.post<void>("/v1/auth/logout"),
      onSuccess: async (data, variables, context, meta) => {
        qc.clear();
        await onSuccess?.(data, variables, context, meta);
      },
    });
  };

  // ===== BASKETS =====
  // One read answers the whole desk: every basket arrives with its legs, marks, booked P&L, close charges
  // and the payoff contracts, so opening a basket costs the phone nothing extra.
  const useBaskets = (source?: string, options?: UseQueryOptions<BasketListResponse, ApiError>) => {
    return useQuery({
      queryKey: queryKeys.baskets.all(source),
      queryFn: () => client.get<BasketListResponse>("/v1/baskets", { params: { source } }),
      staleTime: 5 * 1000,
      refetchInterval: 10 * 1000,
      ...options,
    });
  };

  const invalidateBaskets = () => qc.invalidateQueries({ queryKey: ["baskets"] });

  /** The leg is named by its contract identity, which is what the basket row carries. */
  const useExitLeg = (options?: UseMutationOptions<ExitLegResult, ApiError, ExitLegRequest>) => {
    return useMutation({
      mutationFn: ({ basketId, instrumentId, ...body }) =>
        client.post<ExitLegResult>(`/v1/baskets/${basketId}/legs/${instrumentId}/exit`, body),
      onSuccess: invalidateBaskets,
      ...options,
    });
  };

  const useRecordExitPrice = (options?: UseMutationOptions<void, ApiError, RecordExitPriceRequest>) => {
    return useMutation({
      mutationFn: ({ basketId, ...body }) => client.post(`/v1/baskets/${basketId}/legs/exit-price`, body),
      onSuccess: invalidateBaskets,
      ...options,
    });
  };

  const useRemoveLeg = (options?: UseMutationOptions<void, ApiError, RemoveLegRequest>) => {
    return useMutation({
      mutationFn: ({ basketId, ...body }) => client.post(`/v1/baskets/${basketId}/legs/remove`, body),
      onSuccess: invalidateBaskets,
      ...options,
    });
  };

  const useCloseBasket = (options?: UseMutationOptions<CloseBasketResult, ApiError, CloseBasketRequest>) => {
    return useMutation({
      mutationFn: ({ basketId, ...body }) =>
        client.post<CloseBasketResult>(`/v1/baskets/${basketId}/close`, body),
      onSuccess: invalidateBaskets,
      ...options,
    });
  };

  /** Un-groups a basket from the desk. The broker's book is untouched; the row simply stops being listed. */
  const useDeleteBasket = (options?: UseMutationOptions<void, ApiError, string>) => {
    return useMutation({
      mutationFn: (basketId: string) => client.delete(`/v1/baskets/${basketId}`),
      onSuccess: invalidateBaskets,
      ...options,
    });
  };

  const useBackfillExits = (options?: UseMutationOptions<BackfillResponse, ApiError, BackfillRequest>) => {
    return useMutation({
      mutationFn: (body) => client.post<BackfillResponse>("/v1/baskets/backfill-exits", body),
      ...options,
    });
  };

  // ===== POSITIONS =====
  // Prod has no /v1/positions/open. The desk the owner reads on the web is /v1/broker-auth/icici/account:
  // ICICI's own position rows, each carrying average, last price and marked P&L, and it keeps serving them
  // after the market closes. /v1/hub/positions is a live broker read only, so it returns zero off-hours.
  const useOpenPositions = (options?: UseQueryOptions<OpenPosition[], ApiError>) => {
    return useQuery({
      queryKey: queryKeys.positions.open(),
      queryFn: async () =>
        iciciOpenPositions(await client.get<IciciAccountPayload>("/v1/broker-auth/icici/account")),
      staleTime: 3 * 1000,
      refetchInterval: 5 * 1000,
      ...options,
    });
  };

  // The same account response, unpickled, so a screen can read prod's own state for both lists —
  // cold, stale, degraded or available — without asking for a second, unrelated snapshot. This is a
  // poll of the server's cached copy, not another broker call.
  const useIciciAccount = (options?: UseQueryOptions<IciciAccountPayload, ApiError>) => {
    return useQuery({
      queryKey: queryKeys.brokerAccount.icici(),
      queryFn: () => client.get<IciciAccountPayload>("/v1/broker-auth/icici/account"),
      staleTime: 3 * 1000,
      refetchInterval: 5 * 1000,
      ...options,
    });
  };

  const useClosedPositions = (params?: QueryParams, options?: UseQueryOptions<ClosedPosition[], ApiError>) => {
    return useQuery({
      queryKey: queryKeys.positions.closed(params),
      queryFn: () => client.get<ClosedPosition[]>("/v1/positions/closed", { params: params as Record<string, string | number | boolean | null | undefined> | undefined }),
      staleTime: 30 * 1000,
      ...options,
    });
  };

  // ===== WATCHLIST =====
  // Prod owns the lists: /v1/watchlist?list=N returns the saved symbols already priced by the
  // server, /v1/watchlist/builtin/{name} returns read-only index constituents, and /v1/index-strip
  // returns the headline indices. The /v1/watchlist/snapshot and /v1/watchlist/radar routes this
  // screen used to call do not exist on prod, so nothing here may assume them.
  const useWatchlist = (number: number, options?: UseQueryOptions<WatchlistPage, ApiError>) => {
    return useQuery({
      queryKey: queryKeys.watchlist.list(number),
      queryFn: () => client.get<WatchlistPage>("/v1/watchlist", { params: { list: number } }),
      staleTime: 2 * 1000,
      refetchInterval: (state) => (state.state.data?.pricesPending ? 2_000 : 5_000),
      placeholderData: keepPreviousData,
      ...options,
    });
  };

  // Prod answers a cold list with its membership first and keeps seeding the prices in the
  // background, so the first page says pricesPending until that seed lands. Measured on prod
  // 2026-11-22: a 50-symbol list turns priced 3 s after the cold call, and a batch read is
  // only reused for 5 s (QUOTES_TTL), so a refresh slower than that arrives after the seed's
  // work has already expired and starts another one. Polling at 2 s while pending is what
  // makes the prices show up in one screen-load instead of never.
  const useBuiltinWatchlist = (name: BuiltinListName, page = 0, options?: UseQueryOptions<WatchlistPage, ApiError>) => {
    return useQuery({
      queryKey: queryKeys.watchlist.builtin(name, page),
      queryFn: () => client.get<WatchlistPage>(`/v1/watchlist/builtin/${name}`, { params: { page } }),
      staleTime: 10 * 1000,
      refetchInterval: (state) => (state.state.data?.pricesPending ? 2_000 : 15_000),
      placeholderData: keepPreviousData,
      ...options,
    });
  };

  const useEquitySearch = (query: string, options?: UseQueryOptions<SecuritySearch, ApiError>) => {
    return useQuery({
      queryKey: queryKeys.watchlist.search(query.trim().toUpperCase()),
      queryFn: () => client.get<SecuritySearch>("/v1/equities/search", { params: { q: query.trim() } }),
      enabled: query.trim().length >= 2,
      staleTime: 60 * 60 * 1000,
      ...options,
    });
  };

  /** Adds a symbol to one of the user's own lists; the response is that list, priced. */
  const useAddToWatchlist = (options?: UseMutationOptions<WatchlistPage, ApiError, WatchlistAdd>) => {
    return useMutation({
      mutationFn: ({ exchange, symbol, list }) => client.post<WatchlistPage>("/v1/watchlist", { exchange, symbol, list }),
      onSuccess: (page) => {
        qc.setQueryData(queryKeys.watchlist.list(page.list), page);
        qc.invalidateQueries({ queryKey: ["watchlist", "list"] });
      },
      ...options,
    });
  };

  const useRemoveFromWatchlist = (options?: UseMutationOptions<WatchlistPage, ApiError, WatchlistAdd>) => {
    return useMutation({
      mutationFn: ({ exchange, symbol, list }) =>
        client.delete<WatchlistPage>(`/v1/watchlist/${exchange}/${encodeURIComponent(symbol)}`, { params: { list } }),
      onSuccess: (page) => {
        qc.setQueryData(queryKeys.watchlist.list(page.list), page);
        qc.invalidateQueries({ queryKey: ["watchlist", "list"] });
      },
      ...options,
    });
  };

  /** The lowest unused list number, or a 409 once the user already holds all five. */
  const useCreateWatchlist = (options?: UseMutationOptions<WatchlistPage, ApiError, void>) => {
    return useMutation({
      mutationFn: () => client.post<WatchlistPage>("/v1/watchlist/lists"),
      onSuccess: () => qc.invalidateQueries({ queryKey: ["watchlist"] }),
      ...options,
    });
  };

  const useRenameWatchlist = (options?: UseMutationOptions<{ lists: WatchlistInfo[] }, ApiError, { list: number; name: string }>) => {
    return useMutation({
      mutationFn: ({ list, name }) => client.patch<{ lists: WatchlistInfo[] }>(`/v1/watchlist/lists/${list}`, { name }),
      onSuccess: () => qc.invalidateQueries({ queryKey: ["watchlist"] }),
      ...options,
    });
  };

  // ===== OPTION CHAIN =====
  // Prod answers /v1/option-chain with the whole expiry ladder inside the chain and picks the front
  // expiry when the caller sends none, so an empty expiry means "the nearest one the server chose".
  // There is no separate expiries route; nothing here may wait for one.
  const useOptionChain = (
    underlying: string,
    expiry: string,
    // The key and the read are this hook's own business; a caller sets when the read runs, never what it
    // is cached under, because the all-expiries ladder below shares that key.
    options?: Omit<UseQueryOptions<OptionChainData, ApiError>, "queryKey" | "queryFn">,
  ) => {
    // The ladder only ever hands back live ISO dates, so anything else — a leftover from a saved session,
    // or a contract that has already settled — is dropped rather than sent, because the server rejects the
    // whole read for it. The key comes off the same test: a date this read does not send must not keep the
    // cache entry either, or prod's front-expiry chain lands under a settled date, the ladder is labelled
    // with an expiry it is not, and picking the real one pays the broker for it a second time.
    const asked = ISO_DATE.test(expiry) && expiry >= todayIST() ? expiry : "";
    return useQuery({
      queryKey: queryKeys.optionChain.chain(underlying, asked),
      queryFn: () => client.get<OptionChainData>("/v1/option-chain", {
        // `rate` and `dividend` are required by the route, so a request without them is rejected
        // before the chain is ever read. These are the same values the web desk sends on first paint.
        params: { underlying, window: FULL_WINDOW, rate: 0, dividend: 0, ...(asked ? { expiry: asked } : {}) },
      }),
      enabled: !!underlying,
      staleTime: 2 * 1000,
      // Re-polling a chain that has never arrived turns one failure into an endless spinner.
      refetchInterval: ({ state }) => (state.data ? 3 * 1000 : false),
      ...options,
    });
  };

  /**
   * Every listed expiry of one underlying, each cached under the same key a single-expiry read uses, so
   * switching back to one date from the all-expiries view never asks the broker for it twice.
   *
   * These deliberately do not re-poll: eight live ladders every three seconds would occupy the same
   * broker lane that places the trader's orders, while the expiry on screen keeps polling on its own.
   */
  const useOptionChains = (underlying: string, expiries: readonly string[], wanted: boolean) => {
    return useQueries({
      queries: expiries.map(expiry => ({
        queryKey: queryKeys.optionChain.chain(underlying, expiry),
        queryFn: () => client.get<OptionChainData>("/v1/option-chain", {
          params: { underlying, expiry, window: FULL_WINDOW, rate: 0, dividend: 0 },
        }),
        enabled: wanted && !!underlying && ISO_DATE.test(expiry) && expiry >= todayIST(),
        staleTime: 60 * 1000,
      })),
    });
  };

  /** Every underlying with listed options, indices first, read from the same derivatives master the chain is built from. */
  const useChainUnderlyings = (options?: UseQueryOptions<UnderlyingList, ApiError>) => {
    return useQuery({
      queryKey: queryKeys.optionChain.underlyings(),
      queryFn: () => client.get<UnderlyingList>("/v1/option-chain/underlyings"),
      staleTime: 60 * 60 * 1000,
      ...options,
    });
  };

  /**
   * The exchange-facing underlying behind each broker contract code the book holds.
   *
   * A position row's `stock_code` is ICICI's own token (RELIND, NIFFIN), which is not the name the quote stream
   * subscribes by and cannot be derived from it. Prod answers from the day-cached derivatives master: no broker
   * session, no account read. Codes the master does not list come back unknown and are never guessed into an id.
   */
  const useContractUnderlyings = (codes: readonly string[], options?: Omit<UseQueryOptions<Record<string, string>, ApiError>, "queryKey" | "queryFn">) => {
    const sorted = [...new Set(codes)].sort();
    return useQuery({
      queryKey: ["option-chain", "contract-underlyings", sorted.join(",")] as const,
      queryFn: async () => {
        const body = await client.get<{ items?: { code?: string; underlying?: string }[] }>("/v1/option-chain/contract-underlyings", {
          params: { codes: sorted.join(",") },
        });
        const map: Record<string, string> = {};
        for (const item of body?.items ?? []) {
          const code = String(item?.code ?? "").trim().toUpperCase();
          const underlying = String(item?.underlying ?? "").trim().toUpperCase();
          if (code && underlying) map[code] = underlying;
        }
        return map;
      },
      enabled: sorted.length > 0,
      staleTime: 60 * 60 * 1000,
      ...options,
    });
  };

  /**
   * The server's own basket model: it inverts each leg's volatility from the price sent, so it answers
   * the T+0 curve, the probability of profit and the greeks that no client arithmetic can honestly give.
   * A POST, because the leg set travels in the body, and re-read on a timer rather than on every tick -
   * one call prices the whole basket, and the desk is already pacing the chain read underneath it.
   */
  const useStrategyAnalysis = (body: StrategyAnalysisRequest | null, options?: UseQueryOptions<StrategyAnalysis, ApiError>) => {
    return useQuery({
      queryKey: queryKeys.optionChain.analysis(body as StrategyAnalysisRequest),
      queryFn: () => client.post<StrategyAnalysis>("/v1/strategy-analysis", body),
      enabled: !!body,
      staleTime: 5 * 1000,
      refetchInterval: 15 * 1000,
      ...options,
    });
  };

  /** What the exchange would need in the margin account for this leg set, from the published margin parameters. */
  const usePlanningMargin = (body: MarginRequest | null, options?: UseQueryOptions<MarginEstimate, ApiError>) => {
    return useQuery({
      queryKey: queryKeys.optionChain.margin(body as MarginRequest),
      queryFn: () => client.post<MarginEstimate>("/v1/planning-margin", body),
      enabled: !!body,
      staleTime: 30 * 1000,
      refetchInterval: 60 * 1000,
      ...options,
    });
  };

  // ===== ORDERS =====
  const useOrderIntents = (params?: QueryParams, options?: UseQueryOptions<OrderIntent[], ApiError>) => {
    return useQuery({
      queryKey: queryKeys.orders.intents(params),
      queryFn: async () => {
        const response = await client.get<{ intents: OrderIntent[] }>("/v1/orders", { params });
        return response.intents;
      },
      staleTime: 5 * 1000,
      refetchInterval: 10 * 1000,
      ...options,
    });
  };

  const useBrokerLiveOrders = (options?: UseQueryOptions<BrokerLiveOrder[], ApiError>) => {
    return useQuery({
      queryKey: queryKeys.orders.live,
      queryFn: async () => {
        const response = await client.get<{ orders: BrokerLiveOrder[] }>("/v1/orders/broker-live");
        return response.orders;
      },
      staleTime: 5 * 1000,
      refetchInterval: 10 * 1000,
      ...options,
    });
  };

  const usePlaceOrder = (options?: UseMutationOptions<OrderResponse, ApiError, PlaceOrderRequest>) => {
    return useMutation({
      mutationFn: (body) => client.post<OrderResponse>("/v1/orders", body),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: queryKeys.orders.intents() });
        qc.invalidateQueries({ queryKey: queryKeys.positions.open() });
      },
      ...options,
    });
  };

  /**
   * Prod's contract resolver for a staged basket: it turns 1-8 legs of expiry/strike/right/side/lots
   * into the six-key lines `/v1/orders` takes, and refuses a leg whose contract, lot or expiry does not
   * exist. It creates nothing, so building a strategy costs sends only when the trader presses execute.
   */
  const useOptionDrafts = (options?: UseMutationOptions<OptionDraftsResponse, ApiError, OptionDraftsRequest>) => {
    return useMutation({
      mutationFn: (body) => client.post<OptionDraftsResponse>("/v1/orders/option-drafts", body),
      ...options,
    });
  };

  /**
   * Where one instruction got to. Admission answers before the broker does, so this is the only honest
   * source for a leg after the send. It asks again while any leg is still moving and stops by itself
   * once the basket has landed, so a finished trade never keeps the phone polling prod.
   */
  const useOrderSnapshot = (clientId: string, wanted: boolean) => {
    return useQuery({
      queryKey: queryKeys.orders.snapshot(clientId),
      queryFn: () => client.get<OrderSnapshot>(`/v1/orders/${clientId}`),
      enabled: wanted && clientId.length > 0,
      staleTime: 0,
      refetchInterval: ({ state }) => {
        if (state.data === undefined) return 1000;
        return state.data.orders.some(leg => UNSETTLED_LEG_STATES.has(leg.state)) ? 1000 : false;
      },
    });
  };

  // The one symbol-level read that carries bid and ask. Prod serves it from the same broker
  // evidence the web's stock dialog uses, and reuses five seconds of it, so a ticket opened from
  // the watchlist gets the touch price without a second route.
  const useEquityQuote = (
    exchange: string,
    symbol: string,
    enabled: boolean,
    options?: UseQueryOptions<EquityQuote, ApiError>,
  ) => {
    return useQuery({
      queryKey: queryKeys.orders.quote(exchange, symbol),
      queryFn: () => client.get<EquityQuote>("/v1/equities/quote", { params: { exchange, symbol } }),
      enabled: enabled && symbol.length > 0,
      staleTime: 2 * 1000,
      refetchInterval: enabled ? 3 * 1000 : false,
      ...options,
    });
  };

  // Which broker account the signed-in user's orders would actually go to. A ticket cannot send
  // without it: prod refuses an instruction whose account does not match the live session.
  const useOrderDestinations = (enabled = true, options?: UseQueryOptions<OrderDestinations, ApiError>) => {
    return useQuery({
      queryKey: queryKeys.orders.destinations(),
      queryFn: () => client.get<OrderDestinations>("/v1/orders/destinations"),
      enabled,
      staleTime: 5 * 60 * 1000,
      ...options,
    });
  };

  const useGttOrders = (options?: UseQueryOptions<GttOrder[], ApiError>) => {
    return useQuery({
      queryKey: queryKeys.orders.gtt(),
      queryFn: async () => {
        const response = await client.get<{ gtts: GttOrder[] }>("/v1/orders/gtt");
        return response.gtts;
      },
      staleTime: 5 * 1000,
      refetchInterval: 10 * 1000,
      ...options,
    });
  };

  // ===== MARKET DATA =====
  const useMarketQuotes = (symbols: string[], options?: UseQueryOptions<MarketQuote[], ApiError>) => {
    return useQuery({
      queryKey: queryKeys.market.quotes(symbols),
      queryFn: () => client.get<MarketQuote[]>("/v1/quotes", { params: { symbols: symbols.join(",") } }),
      enabled: symbols.length > 0,
      staleTime: 500,
      refetchInterval: 1000,
      ...options,
    });
  };

  // Prod's headline ticker is /v1/index-strip; the /v1/indices route this used to call does not exist.
  // overview=true asks for prices alone, because option lot sizes belong to the chain desk, not a strip.
  const useIndices = (options?: UseQueryOptions<IndexStrip, ApiError>) => {
    return useQuery({
      queryKey: queryKeys.market.indices(),
      queryFn: async () =>
        indexStripRows(await client.get<StripPayload>("/v1/index-strip", { params: { overview: true } })),
      staleTime: 5 * 1000,
      refetchInterval: 15 * 1000,
      ...options,
    });
  };

  const useMarketDepth = (symbol: string, options?: UseQueryOptions<MarketDepth, ApiError>) => {
    return useQuery({
      queryKey: queryKeys.market.depth(symbol),
      queryFn: () => client.get<MarketDepth>(`/v1/depth/${symbol}`),
      enabled: !!symbol,
      staleTime: 500,
      refetchInterval: 1000,
      ...options,
    });
  };

  // ===== SCANNER =====
  const useAutomations = (options?: UseQueryOptions<Automation[], ApiError>) => {
    return useQuery({
      queryKey: queryKeys.scanner.automations(),
      queryFn: () => client.get<Automation[]>("/v1/scanner-automations"),
      staleTime: 30 * 1000,
      ...options,
    });
  };

  const useLiveTrades = (options?: UseQueryOptions<LiveTrade[], ApiError>) => {
    return useQuery({
      queryKey: queryKeys.scanner.liveTrades(),
      queryFn: () => client.get<LiveTrade[]>("/v1/scanner-automations/live-trades"),
      staleTime: 5 * 1000,
      refetchInterval: 10 * 1000,
      ...options,
    });
  };

  // ===== ALGO LAB =====
  const useFleet = (options?: UseQueryOptions<FleetItem[], ApiError>) => {
    return useQuery({
      queryKey: queryKeys.algoLab.fleet(),
      queryFn: () => client.get<FleetItem[]>("/v1/algo-lab/fleet"),
      staleTime: 10 * 1000,
      ...options,
    });
  };

  const useDrafts = (options?: UseQueryOptions<Draft[], ApiError>) => {
    return useQuery({
      queryKey: queryKeys.algoLab.drafts(),
      queryFn: () => client.get<Draft[]>("/v1/algo-lab/drafts"),
      staleTime: 30 * 1000,
      ...options,
    });
  };

  // ===== TERMINAL =====
  /** Candles for one chart key at one interval. `name` may be a bare symbol; it is prefixed for the route. */
  const useTerminalChart = (name: string, interval: string, options?: Omit<UseQueryOptions<ChartData, ApiError>, "queryKey" | "queryFn">) => {
    const instrument = chartInstrument(name);
    const request = chartRequest(instrument, interval);
    return useQuery({
      queryKey: queryKeys.terminal.chart(instrument, interval),
      queryFn: () => client.get<ChartData>(request.path, { params: request.params }),
      enabled: !!instrument && !!interval,
      staleTime: DAILY_INTERVALS.has(interval) ? 10 * 60 * 1000 : 30 * 1000,
      ...options,
    });
  };

  // ===== HISTORY =====
  const useHistory = (params?: QueryParams, options?: UseQueryOptions<HistoryResponse, ApiError>) => {
    return useQuery({
      queryKey: queryKeys.history.all(params),
      queryFn: () => client.get<HistoryResponse>("/v1/history", { params }),
      staleTime: 30 * 1000,
      ...options,
    });
  };

  return {
    // Auth
    useMe,
    useBrokers,
    useLogin,
    useLogout,
    // Baskets
    useBaskets,
    useExitLeg,
    useRecordExitPrice,
    useRemoveLeg,
    useCloseBasket,
    useDeleteBasket,
    useBackfillExits,
    // Positions
    useOpenPositions,
    useClosedPositions,
    useIciciAccount,
    // Watchlist
    useWatchlist,
    useBuiltinWatchlist,
    useEquitySearch,
    useAddToWatchlist,
    useRemoveFromWatchlist,
    useCreateWatchlist,
    useRenameWatchlist,
    // Option Chain
    useOptionChain,
    useOptionChains,
    useChainUnderlyings,
    useContractUnderlyings,
    useStrategyAnalysis,
    usePlanningMargin,
    // Orders
    useOrderIntents,
    useBrokerLiveOrders,
    usePlaceOrder,
    useOptionDrafts,
    useOrderSnapshot,
    useEquityQuote,
    useOrderDestinations,
    useGttOrders,
    // Market
    useMarketQuotes,
    useIndices,
    useMarketDepth,
    // Scanner
    useAutomations,
    useLiveTrades,
    // Algo Lab
    useFleet,
    useDrafts,
    // Terminal
    useTerminalChart,
    // History
    useHistory,
  };
}

// Type for the API hooks object returned by createApiHooks
export type ApiHooks = ReturnType<typeof createApiHooks>;

// Type definitions (mirror backend schemas)
export interface User {
  id: string;
  email: string;
  name: string;
  tier: "free" | "pro" | "enterprise";
  brokers: string[];
}

export interface BrokerStatus {
  provider: string;
  connected: boolean;
  accountId?: string;
  accountName?: string;
  expiresAt?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  otp?: string;
  remember?: boolean;
}

/** `mfaRequired: true` is the password-accepted step; the other shape proves a session exists. */
export type LoginResponse =
  | { mfaRequired: true }
  | { mfaRequired?: false; email: string; mfaEnrollmentRequired: boolean };

export interface BasketListResponse {
  baskets: Basket[];
  /** Prod's own sentence about where these rows came from and which source failed to load. */
  basis: string;
  /** Prod leaves this empty: an ungrouped position is worked out by the desk from the broker book. */
  unattributed: UnattributedLeg[];
}

/** One leg of a recorded basket, exactly as the server's BasketOut sends it. */
export interface BasketLeg {
  instrumentId: string;
  symbol: string;
  exchange: string;
  product: string;
  side: "BUY" | "SELL";
  quantity: number;
  entryPrice: number;
  exitPrice?: number | null;
  markPrice?: number | null;
  lots: number;
  lotSize: number;
  role?: string | null;
  exited: number;
  bookedPnl?: number | null;
  pending: boolean;
  /** Where an exit price came from when it was not this app's own order: the broker trade book or a price the trader typed. */
  exitSource?: string | null;
  exitAt?: string | null;
  exitNote?: string | null;
  bookedBasis?: string | null;
}

/** The open option legs, as the payoff chart reads them. Empty when the contracts are not exactly known. */
export interface PayoffLeg {
  instrumentId: string;
  underlying: string;
  symbol: string;
  expiry: string;
  strike: string;
  right: "CE" | "PE";
  /** Lowercase here, unlike BasketLeg.side. */
  action: "buy" | "sell";
  lots: number;
  lotSize: number;
  entryPrice: string;
}

/** What a basket still has working at the broker, when the basket came from one live order ticket. */
export interface BasketWorking {
  label: string;
  filled: number;
  total: number;
}

/** An estimated close's cost, or the reason this app cannot estimate it yet. Money arrives as strings. */
export interface BasketCharges {
  available: boolean;
  uncountedLots: number;
  total?: string | null;
  turnover?: string;
  fills?: number;
  lines?: Record<string, string>;
  reason?: string;
  basis?: string;
}

/** BasketOut. `kind` is 'order' | 'run' | 'manual' | 'paper'; a 'run' is live unless the provider says paper. */
export interface Basket {
  id: string;
  name: string;
  kind: string;
  sourceRef?: string | null;
  underlying: string;
  expiry: string;
  spot: number;
  tau: number;
  legs: BasketLeg[];
  margin: number;
  account: string;
  provider: string;
  attribution: string;
  realized: number;
  status: string;
  working?: BasketWorking | null;
  tags: string[];
  openedAt?: string | null;
  closedAt?: string | null;
  payoffLegs: PayoffLeg[];
  warnings: string[];
  charges?: BasketCharges | null;
}

/** A broker position the desk could not tie to any basket. */
export interface UnattributedLeg {
  instrumentId: string;
  symbol: string;
  exchange: string;
  product: string;
  side: "BUY" | "SELL";
  quantity: number;
  entryPrice: number;
  markPrice?: number | null;
  lots: number;
  lotSize: number;
}

export interface ExitLegRequest {
  basketId: string;
  instrumentId: string;
  lots: number;
  price: number;
}

export interface ExitLegResult {
  success: boolean;
  booked_pnl: number;
  exit_price: number;
  charges: number;
  remaining_qty: number;
}

export interface CloseBasketRequest {
  basketId: string;
  prices?: Record<string, number>;
}

export interface CloseBasketResult {
  success: boolean;
  closed?: boolean;
  realized?: number;
}

export interface RecordExitPriceRequest {
  basketId: string;
  symbol: string;
  price: number;
  quantity?: number;
}

export interface RemoveLegRequest {
  basketId: string;
  symbol: string;
  instrumentId?: string;
}

export interface BackfillRequest {
  since?: string;
  until?: string;
  symbols?: string[];
}

export interface BackfillResponse {
  provider: string;
  accountId: string;
  since: string;
  until: string;
  coveredFrom?: string;
  complete: boolean;
  executions: number;
  stored: number;
  orders: number;
  wanted: number;
  detailReads: number;
  failedReads: number;
  unpricedFills: number;
  deferredOrders: number;
  failure?: string;
}

export interface OpenPosition {
  symbol: string;
  side: "BUY" | "SELL" | "OTHER";
  quantity: number;
  // ICICI returns no average for MCX option legs, so a missing figure stays null rather than a fabricated 0.
  entryPrice: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
  broker: string;
  account: string;
  product: string;
  exchange: string;
  expiry: string | null;
  // The two halves of a derivative's identity the broker sends beside its code. Together with the underlying
  // name they are what a canonical stream subscription is built from; a cash row carries neither.
  strike: string | null;
  right: string | null;
}

interface IciciPositionRow {
  stock_code?: string | null;
  exchange_code?: string | null;
  product_type?: string | null;
  expiry_date?: string | null;
  strike_price?: string | number | null;
  right?: string | null;
  action?: string | null;
  quantity?: string | number | null;
  average_price?: string | number | null;
  ltp?: string | number | null;
  marked_pnl_paise?: string | number | null;
}

/** One section of the account response. Prod names its own state and its own reason, so a screen
 *  never has to guess why a list is empty. */
export interface IciciSection<T> {
  status?: "available" | "degraded" | "unavailable" | string | null;
  rows?: T[] | null;
  asOf?: string | null;
  reason?: string | null;
}

interface IciciHoldingRow {
  stock_code?: string | null;
  stock_name?: string | null;
  exchange_code?: string | null;
  quantity?: string | number | null;
  average_price?: string | number | null;
  current_market_price?: string | number | null;
  change_percentage?: string | number | null;
  booked_profit_loss?: string | number | null;
  investment_value?: string | number | null;
  market_value?: string | number | null;
  today_holding_pnl_estimate?: string | number | null;
  unrealized_holding_pnl?: string | number | null;
  quote_as_of?: string | null;
}

export interface IciciAccountPayload {
  accountId?: string | null;
  asOf?: string | null;
  stale?: boolean | null;
  staleReason?: string | null;
  refreshing?: boolean | null;
  // A cold account is answered with HTTP 202 and this body, and 2xx is not an error to the client,
  // so a screen that only looks at rows would report an empty book while prod is still reading it.
  detail?: string | null;
  sections?: {
    portfoliopositions?: IciciSection<IciciPositionRow> | null;
    portfolioholdings?: IciciSection<IciciHoldingRow> | null;
    dematholdings?: IciciSection<Record<string, unknown>> | null;
    order?: IciciSection<IciciOrderRow> | null;
    orders_NSE?: IciciSection<IciciOrderRow> | null;
    orders_NFO?: IciciSection<IciciOrderRow> | null;
  } | null;
}

export interface IciciOrderRow {
  order_id?: string | number | null;
  exchange_code?: string | null;
  stock_code?: string | null;
  product_type?: string | null;
  action?: string | null;
  order_type?: string | null;
  price?: string | number | null;
  quantity?: string | number | null;
  pending_quantity?: string | number | null;
  cancelled_quantity?: string | number | null;
  filled_quantity?: string | number | null;
  average_price?: string | number | null;
  status?: string | null;
  order_datetime?: string | null;
  order_time?: string | null;
  exchange_time?: string | null;
  message?: string | null;
  remark?: string | null;
  validity?: string | null;
  user_remark?: string | null;
}

/** Prod sends some figures as numbers and others as text, so every figure is read the same way.
 *  A value the server left blank stays null: Number("") is 0, which would report a price the
 *  broker never gave. */
const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (text === "") return null;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** Marks the way the web desk does: the broker reports no price as null, and 0 is not a price. */
const iciciPrice = (value: unknown): number | null => {
  const n = toNumber(value);
  return n !== null && n > 0 ? n : null;
};

/** The owner's open positions, from the broker rows the Positions desk on the web reads.
 *  A flat row (quantity 0) is not a position, matching the web filter. */
export function iciciOpenPositions(payload: IciciAccountPayload): OpenPosition[] {
  const account = payload.accountId ?? "unknown";
  const rows = payload.sections?.portfoliopositions?.rows ?? [];
  return rows
    .filter(row => {
      const quantity = toNumber(row.quantity);
      return quantity !== null && quantity !== 0;
    })
    .map(row => {
      const action = String(row.action ?? "").trim().toUpperCase();
      const side: OpenPosition["side"] = action.startsWith("B") ? "BUY" : action.startsWith("S") ? "SELL" : "OTHER";
      const quantity = Math.abs(toNumber(row.quantity) ?? 0);
      // ICICI's own code already names the strike and the side, and it is the token /v1/orders places,
      // so a row keeps exactly what the broker sent. Appending strike and right again produced a label
      // with spaces in it, which is the one form the order ticket's contract refuses.
      const symbol = String(row.stock_code ?? "").trim();
      const markedPaise = toNumber(row.marked_pnl_paise);
      return {
        symbol: symbol || "Unavailable",
        side,
        quantity,
        entryPrice: iciciPrice(row.average_price),
        markPrice: iciciPrice(row.ltp),
        unrealizedPnl: markedPaise === null ? null : markedPaise / 100,
        broker: "icici",
        account,
        product: String(row.product_type ?? "Unavailable"),
        exchange: String(row.exchange_code ?? "Unavailable"),
        expiry: row.expiry_date == null ? null : String(row.expiry_date),
        strike: row.strike_price == null ? null : String(row.strike_price),
        right: row.right == null ? null : String(row.right),
      };
    });
}

/** One delivery holding, in plain words. ICICI's own holding rows carry the figures; nothing here
 *  is computed on the client, so a number on the screen is a number the broker reported. */
export interface Holding {
  symbol: string;
  name: string | null;
  exchange: string;
  quantity: number;
  averagePrice: number | null;
  currentPrice: number | null;
  changePercent: number | null;
  investedValue: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  todayPnl: number | null;
  bookedPnl: number | null;
  accountId: string;
  asOf: string | null;
}

/** The owner's delivery holdings, from the section the web's cash-holdings desk reads. Demat rows are
 *  identity evidence only and never feed this list. A flat row is not a holding, matching the
 *  positions filter above. */
export function iciciHoldings(payload: IciciAccountPayload): Holding[] {
  const account = payload.accountId ?? "unknown";
  const section = payload.sections?.portfolioholdings;
  const rows = section?.rows ?? [];
  return rows
    .filter(row => {
      const quantity = toNumber(row.quantity);
      return quantity !== null && quantity !== 0;
    })
    .map(row => {
      const quantity = Math.abs(toNumber(row.quantity) ?? 0);
      return {
        symbol: String(row.stock_code ?? "Unavailable"),
        name: row.stock_name == null || String(row.stock_name).trim() === "" ? null : String(row.stock_name),
        exchange: String(row.exchange_code ?? "Unavailable"),
        quantity,
        averagePrice: iciciPrice(row.average_price),
        currentPrice: iciciPrice(row.current_market_price),
        changePercent: toNumber(row.change_percentage),
        // Prod already turned these paise figures into rupees, so dividing again would shrink every
        // holding a hundredfold. They stay null when the broker had no price to value against.
        investedValue: toNumber(row.investment_value),
        marketValue: toNumber(row.market_value),
        unrealizedPnl: toNumber(row.unrealized_holding_pnl),
        todayPnl: toNumber(row.today_holding_pnl_estimate),
        bookedPnl: toNumber(row.booked_profit_loss),
        accountId: account,
        asOf: row.quote_as_of ?? section?.asOf ?? payload.asOf ?? null,
      };
    });
}

/** One broker order, normalized from ICICI's native row shape. */
export interface BrokerOrder {
  orderId: string;
  provider: string;
  exchange: string;
  symbol: string | null;
  side: "BUY" | "SELL" | null;
  product: string | null;
  orderType: string | null;
  quantity: number;
  price: number | null;
  filledQuantity: number | null;
  pendingQuantity: number | null;
  status: string;
  timestamp: string | null;
  message: string | null;
}

/** All orders from the ICICI account snapshot — the single source of truth for broker orders.
 *  Prod merges orders_NSE + orders_NFO into a single `order` section, so we only read that. */
export function iciciOrders(payload: IciciAccountPayload): BrokerOrder[] {
  const account = payload.accountId ?? "unknown";
  const section = payload.sections?.order;
  if (!section?.rows?.length) return [];

  const orders: BrokerOrder[] = [];
  for (const row of section.rows) {
    const qty = toNumber(row.quantity) ?? 0;
    const filled = toNumber(row.filled_quantity) ?? toNumber(row.quantity) ?? 0;
    const pending = toNumber(row.pending_quantity) ?? 0;
    const action = String(row.action ?? "").trim().toUpperCase();
    orders.push({
      orderId: String(row.order_id ?? ""),
      provider: "icici",
      exchange: String(row.exchange_code ?? ""),
      symbol: row.stock_code ? String(row.stock_code) : null,
      side: action === "BUY" ? "BUY" : action === "SELL" ? "SELL" : null,
      product: row.product_type ? String(row.product_type) : null,
      orderType: row.order_type ? String(row.order_type) : null,
      quantity: Math.abs(qty),
      price: iciciPrice(row.price),
      filledQuantity: Math.abs(filled),
      pendingQuantity: Math.abs(pending),
      status: String(row.status ?? "UNKNOWN"),
      timestamp: row.order_datetime ?? row.order_time ?? row.exchange_time ?? null,
      message: row.message ?? row.remark ?? null,
    });
  }
  return orders;
}

export type AccountSectionKind = "cold" | "ready" | "stale" | "degraded" | "unavailable";

/** Which of prod's five answers this list is in, with the server's own words for why. A screen uses
 *  this instead of treating "no rows" as "nothing to show", which during a cold snapshot is a lie. */
export function iciciAccountSection(
  payload: IciciAccountPayload | undefined | null,
  name: "portfolioholdings" | "portfoliopositions",
): { kind: AccountSectionKind; reason: string | null } {
  if (!payload) return { kind: "unavailable", reason: null };
  if (!payload.sections && typeof payload.detail === "string" && payload.detail !== "") {
    return { kind: "cold", reason: payload.detail };
  }
  const section = name === "portfolioholdings" ? payload.sections?.portfolioholdings : payload.sections?.portfoliopositions;
  // An answer that names sections but omits this one never carried the list at all. Calling that `ready`
  // let the desk render an empty book, which is the one reading a trader cannot act on.
  if (!section) return { kind: "unavailable", reason: `The broker's answer did not include ${name === "portfolioholdings" ? "holdings" : "positions"}.` };
  const status = String(section?.status ?? "");
  if (status === "unavailable") return { kind: "unavailable", reason: section?.reason ?? payload.staleReason ?? null };
  if (status === "degraded") return { kind: "degraded", reason: section?.reason ?? payload.staleReason ?? null };
  if (payload.stale === true) {
    return { kind: "stale", reason: payload.staleReason ?? "Showing last saved broker data." };
  }
  return { kind: "ready", reason: null };
}

export interface ClosedPosition {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  entryPrice: number;
  exitPrice: number | null;
  realizedPnl: number | null;
  closedAt: string | null;
  provider: string;
  account: string;
  basket: string | null;
  source: string;
}

/** One watchlist row as prod prices it. A symbol the server could not price stays null. */
export interface WatchlistRow {
  exchange: string;
  symbol: string;
  name: string;
  ltp: number | null;
  close: number | null;
  change: number | null;
  changePct: number | null;
}

export interface WatchlistInfo {
  number: number;
  count: number;
  name?: string;
}

/** The envelope shared by GET /v1/watchlist?list=N and GET /v1/watchlist/builtin/{name}. */
export interface WatchlistPage {
  asOf: string;
  list: number;
  limit: number;
  maxLists: number;
  lists: WatchlistInfo[];
  pricesAvailable: boolean;
  pricesPending: boolean;
  items: WatchlistRow[];
  name?: string;
  readOnly?: boolean;
  total?: number;
  page?: number;
  pageSize?: number;
  membershipSource?: string;
}

export type BuiltinListName = "nifty_50" | "nifty_bank" | "nifty_midcap_150" | "fo";

/** The read-only lists prod builds from published index membership, in tab order. */
export const BUILTIN_LISTS: { name: BuiltinListName; label: string }[] = [
  { name: "nifty_50", label: "Nifty 50" },
  { name: "nifty_bank", label: "Bank Nifty" },
  { name: "nifty_midcap_150", label: "Midcap 150" },
  { name: "fo", label: "F&O stocks" },
];

export interface WatchlistAdd {
  exchange: string;
  symbol: string;
  list: number;
}

export interface SecuritySearch {
  results: { exchange: string; symbol: string; name: string }[];
  verified: boolean;
  catalogueTotal: number;
  source: string;
}

/** What the server knows about one quoted price. A chain never fabricates a change figure. */
export type QuoteQuality = "live" | "delayed" | "stale" | "eod" | "manual" | "unavailable";

/** Prod names its quote states in code; every screen says the same words for what they mean. */
export const QUALITY_WORD: Record<string, string> = {
  live: "live price",
  delayed: "delayed price",
  stale: "old price",
  eod: "last close",
  manual: "a hand-entered price",
  unavailable: "no price from the broker",
};

export interface OptionChainData {
  underlying: string;
  /** The expiry these rows belong to; chosen by the server when the caller asked for none. */
  expiry: string;
  /** Every expiry currently listed for this underlying, oldest first — the picker's own choices. */
  expiries: string[];
  lotSize: number;
  spot: SpotQuote;
  atTheMoneyStrike: string;
  rows: OptionRow[];
  marketOpen: boolean;
  /** How these prices were arrived at, in the server's own words. */
  basis: string;
  provider: string;
  /** Present only when the live source could not answer and another one supplied these prices. */
  fallback?: { from: string; to: string; reason: string } | null;
  asOf: string;
}

export interface SpotQuote {
  price: string | null;
  quality: QuoteQuality;
  at: string | null;
  source?: string;
}

export interface OptionRow {
  strike: string;
  isAtTheMoney: boolean;
  call: OptionQuote | null;
  put: OptionQuote | null;
}

export interface OptionQuote {
  symbol: string;
  /**
   * The identity the broker's own master binds this row to, or null when the provider has none to give.
   * This is what a press sends: a ladder quotes an option under one label and the broker orders it under
   * another, so the row's own `symbol` is not always placeable. Reference for aiming only - prod still
   * re-checks it against the master at send time.
   */
  order: { exchange: string; tradingsymbol: string } | null;
  instrumentId: string;
  ltp: string | null;
  bid: string | null;
  ask: string | null;
  iv: number | null;
  delta: number | null;
  oi: number | null;
  /** Percent change in open interest since the previous session, null when the source has none. */
  oiChangePct: number | null;
  volume: number | null;
  ltpAt?: string | null;
  quote: { at: string | null; quality: QuoteQuality };
}

export interface UnderlyingInfo {
  name: string;
  lotSize: number;
  /** True for an index (NIFTY, BANKNIFTY, SENSEX); false for an F&O stock. */
  index: boolean;
}

export interface UnderlyingList {
  asOf: string;
  provider: string;
  underlyings: UnderlyingInfo[];
}

/** One leg of the POST body. The server model forbids unknown keys, so this list is the whole contract. */
export interface StrategyAnalysisLeg {
  action: "buy" | "sell";
  right: "CE" | "PE";
  exchange: "NSE" | "BSE";
  strike: string;
  expiry: string;
  lots: number;
  lotSize: number;
  price: string;
  entryPrice?: string;
  /** The underlying price this option price was seen against. Without it there is no T+0 estimate. */
  entrySpot?: string;
  /** When that price was seen, with its offset. */
  pricedAt?: string;
}

export interface StrategyAnalysisRequest {
  spot: string;
  rate: number;
  dividend: number;
  spotShockPct?: number;
  ivShiftPoints?: number;
  legs: StrategyAnalysisLeg[];
}

export interface MarginRequestLeg {
  underlying: string;
  exchange: "NSE" | "BSE" | "UNKNOWN";
  action: "buy" | "sell";
  right: "CE" | "PE";
  strike: string;
  expiry: string;
  lots: number;
  lotSize: number;
  price?: string;
  spot?: string;
  previousClose?: string;
}

export interface MarginRequest {
  legs: MarginRequestLeg[];
}

/** Prod's StrategyAnalysis, field for field. Money and strikes are decimal strings; curve values are rupees. */
export interface StrategyAnalysis {
  spot: string;
  assumptions: { ratePct: number; dividendPct: number };
  curve: {
    spots: number[];
    /** The payoff at expiry, one value per `spots`. */
    expiry: number[] | null;
    /** The T+0 estimate, one value per `spots`. Null when the model could not calibrate the basket. */
    today: number[] | null;
    /** Expiry payoff less the entry charges. */
    postTax?: number[];
  };
  expiry: {
    available: boolean;
    reason?: string;
    /** Set when the legs expire on different dates: the curve is drawn at this, the earliest, date. */
    basis?: "front-expiry";
    settlement?: string;
    maxProfit?: string | null;
    maxProfitUnbounded?: boolean;
    maxLoss?: string | null;
    maxLossUnbounded?: boolean;
    breakevens?: string[];
    netDebit?: string;
  };
  /** Single-expiry strategies only. */
  friction?: {
    available: boolean;
    turnover?: string;
    lines?: Record<string, string>;
    total?: string;
    basis?: string;
    postTax?: { maxProfit: string | null; maxLoss: string | null; breakevenShiftPoints: string | null; breakevens?: string[] };
  };
  greeks:
    | { available: true; delta: number; gamma: number; theta: number; vega: number; rho?: number;
        ivPct: number; basis: string; legs: { delta: number; theta: number; ivPct?: number }[] }
    | { available: false; reason: string };
  pop: { available: true; value: number; basis: string } | { available: false; reason: string };
  scenario:
    | { available: true; spot: number; spotShockPct: number; ivShiftPoints: number; pnlToday: number; pnlAtExpiry: number | null }
    | { available: false; reason: string };
}

/**
 * What /v1/planning-margin answers: the estimate, or the reason there is none. Every money value is a
 * decimal string, and the endpoint takes at most eight legs.
 */
export interface MarginEstimate {
  available: boolean;
  amount?: string | null;
  span?: string | null;
  reason?: string | null;
  stale?: boolean;
  parameterDate?: string | null;
  parameterFile?: string | null;
  breakdown?: { riskRequirement?: string; exposure?: string; premium?: string };
  label?: string;
  method?: string;
  brokerVerified?: boolean;
  notes?: string[];
  asOf?: string | null;
  feedStatus?: string | null;
}

export interface OrderIntent {
  clientId: string;
  provider: string;
  brokerAccountId?: string;
  accountId?: string;
  basketName?: string;
  createdAt: string;
  updatedAt?: string | null;
  orders: OrderLine[];
  status: "queued" | "working" | "unknown" | "filled" | "partial" | "cancelled" | "failed";
  message?: string | null;
}

export interface OrderLine {
  index?: number;
  tradingsymbol: string;
  symbol?: string;
  side: "BUY" | "SELL";
  exchange: string;
  product: string;
  quantity: number;
  price?: string | number;
  filledQuantity: number;
  averagePrice: string | null;
  state: string;
  message?: string | null;
  orderId?: string;
}

export interface BrokerLiveOrder {
  order_id: string;
  provider: string;
  exchange: string;
  tradingsymbol: string | null;
  product: string | null;
  transaction_type: "BUY" | "SELL";
  order_type: string;
  quantity: number;
  price: number | null;
  filled_quantity: number | null;
  pending_quantity: number | null;
  status: string;
  order_timestamp: string | null;
  tag?: string | null;
  message?: string | null;
}

export interface GttOrder {
  id: string;
  draft_id: string | null;
  provider: string;
  account_id: string;
  order_spec: Record<string, unknown>;
  trigger_price: string;
  state: "requested" | "placing" | "active" | "failed" | "cancelled" | "cancel_requested" | "cancelling" | "unknown";
  broker_gtt_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One instruction handed to prod. `clientId` is the idempotency reference the server fences on, so
 * a retry of the same ticket must reuse it instead of generating a new one, and an unanswered
 * request is never proof that nothing was placed.
 */
export interface PlaceOrderRequest {
  clientId: string;
  provider: string;
  accountId: string;
  basketName?: string;
  orders: PlaceOrderLine[];
}

/**
 * Prod accepts exactly these six keys and nothing else: its model forbids extras, and a price is
 * mandatory because every instruction leaves as a limit. `price` is a two-decimal string, the same
 * form the web ticket freezes into its retry journal.
 */
export interface PlaceOrderLine {
  tradingsymbol: string;
  exchange: "NSE" | "BSE" | "NFO" | "BFO";
  side: "BUY" | "SELL";
  quantity: number;
  product: "CNC" | "MIS" | "NRML";
  price: string;
}

export interface OrderDestination {
  provider: string;
  accountId: string;
}

export interface OrderDestinations {
  accounts: OrderDestination[];
}

/**
 * The single-symbol read behind the buy popup. Prod omits a side of the book it has no evidence
 * for, so `bid`/`ask` stay optional and `depthMessage` carries the reason the screen can show.
 */
export interface EquityQuote {
  exchange: string;
  symbol: string;
  name?: string | null;
  ltp?: number | null;
  close?: number | null;
  change?: number | null;
  changePct?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
  bid?: number | null;
  ask?: number | null;
  bidQuantity?: number | null;
  askQuantity?: number | null;
  at?: string | null;
  source?: string | null;
  depthMessage?: string | null;
}

/**
 * Prod's receipt for one instruction. Admission is asynchronous, so a leg's `orderId` is absent
 * until the broker acknowledges it and `state` is what the screen is allowed to describe.
 */
export interface OrderResponse {
  clientId: string;
  provider?: string;
  status: string;
  message?: string | null;
  repeat?: boolean;
  admissionMs?: number;
  orders: Array<{
    orderId?: string | null;
    tradingsymbol: string;
    state: string;
    message?: string | null;
    filledQuantity?: number;
    averagePrice?: string | null;
  }>;
}

/** One leg as the builder holds it: what the trader chose, before prod names the contract. */
export interface OptionDraftLeg {
  expiry: string;
  strike: string;
  right: "CE" | "PE";
  side: "BUY" | "SELL";
  lots: number;
  lotSize: number;
  /** The limit price this leg leaves at, two decimals, because prod has no market order. */
  price: string;
}

/**
 * The basket handed to prod's resolver. `accountId` is left out unless the trader picked one, and the
 * server then binds its own live broker session and answers with the account it used.
 */
export interface OptionDraftsRequest {
  provider: string;
  accountId?: string;
  underlying: string;
  legs: OptionDraftLeg[];
}

/** The resolved lines, in the order they were staged, ready for `/v1/orders` without further edits. */
export interface OptionDraftsResponse {
  provider: string;
  accountId: string;
  orders: PlaceOrderLine[];
}

/**
 * What became of one instruction. `status` is the basket's, `phase` how far prod got with it, and each
 * leg carries the broker's own answer once there is one — so this is the screen's only evidence of a
 * fill, since the send itself is admission and never a fill.
 */
export interface OrderSnapshot {
  clientId: string;
  provider?: string;
  basketName?: string | null;
  status: string;
  phase?: string | null;
  message?: string | null;
  createdAt?: string;
  cancelRequested?: boolean;
  orders: Array<{
    index: number;
    exchange: string;
    tradingsymbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    price: string;
    state: string;
    filledQuantity?: number | null;
    averagePrice?: string | null;
    orderId?: string | null;
    message?: string | null;
  }>;
}

export interface MarketQuote {
  symbol: string;
  ltp: number | null;
  close: number | null;
  change: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  at: string;
  quality: "live" | "stale" | "fallback";
}

/** One headline index, as the screen needs it: figures parsed, a missing price kept null. */
export interface IndexQuote {
  name: string;
  label: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  /** What prod says about the figure itself: live, delayed, stale, official-close or unavailable. */
  status: string;
  at: string | null;
}

export interface IndexStrip {
  asOf: string;
  provider: string;
  marketOpen: boolean;
  indices: IndexQuote[];
}

interface StripIndexRow {
  name?: string | null;
  price?: string | number | null;
  change?: string | number | null;
  changePct?: string | number | null;
  priceStatus?: string | null;
  dataStatus?: string | null;
  quote?: { at?: string | null } | null;
}

interface StripPayload {
  asOf?: string | null;
  provider?: string | null;
  marketOpen?: boolean | null;
  indices?: StripIndexRow[] | null;
}

/** Prod's index codes are not what a trader reads on a screen, so each gets its published name. */
const INDEX_LABELS: Record<string, string> = {
  NIFTY: "NIFTY 50",
  BANKNIFTY: "NIFTY BANK",
  FINNIFTY: "NIFTY FIN SERVICE",
  MIDCPNIFTY: "NIFTY MID SELECT",
  NIFTYMIDCAP100: "NIFTY MIDCAP 100",
  NIFTYSMALLCAP100: "NIFTY SMALLCAP 100",
  SENSEX: "SENSEX",
  BANKEX: "BSE BANKEX",
  INDIAVIX: "INDIA VIX",
};

export function indexStripRows(payload: StripPayload): IndexStrip {
  return {
    asOf: payload.asOf ?? "",
    provider: payload.provider ?? "unavailable",
    marketOpen: payload.marketOpen === true,
    indices: (payload.indices ?? []).map(row => ({
      name: String(row.name ?? "Unavailable"),
      label: INDEX_LABELS[String(row.name ?? "")] ?? String(row.name ?? "Unavailable"),
      price: toNumber(row.price),
      change: toNumber(row.change),
      changePct: toNumber(row.changePct),
      status: String(row.dataStatus ?? row.priceStatus ?? "unavailable"),
      at: row.quote?.at ?? null,
    })),
  };
}

export interface MarketDepth {
  symbol: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
  at: string;
}

export interface DepthLevel {
  price: number;
  quantity: number;
  orders: number;
}

export interface Automation {
  id: string;
  name: string;
  status: "running" | "stopped" | "error";
  config: Record<string, unknown>;
  lastRun?: string;
  nextRun?: string;
}

export interface LiveTrade {
  id: string;
  automationId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  openedAt: string;
  status: "open" | "closing" | "closed";
}

export interface FleetItem {
  id: string;
  name: string;
  status: "running" | "stopped" | "pending";
  capital: number;
  deployed: number;
  pnl: number;
  strategy: string;
}

export interface Draft {
  id: string;
  name: string;
  legs: DraftLeg[];
  createdAt: string;
  updatedAt: string;
}

export interface DraftLeg {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  strike: number;
  expiry: string;
  right: "CE" | "PE";
  underlying: string;
}

export interface ChartData {
  candles: Candle[];
  hasMore: boolean;
  source: string;
  /** The bar the live recorder is still building. Only the intraday route sends one; it is the candle ticks extend. */
  forming?: Candle | null;
  /** The server's own freshness label for this record (LIVE, STALE, FALLBACK, NO_DATA, ...). */
  dataStatus?: string | null;
  /** True when the record came from the live session rather than a stored archive. */
  live?: boolean;
  asOf?: string | null;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface HistoryResponse {
  closedBaskets: ClosedBasketView[];
  automatedRuns: ClosedAutomatedRun[];
  singleTrades: ClosedSingleTrade[];
  closedCount: number | null;
}

export interface ClosedBasketView {
  id: string;
  name: string;
  expiry: string;
  account: string;
  provider: string;
  realized: number;
  status: string;
  closedAt: string | null;
  legs: ClosedBasketLeg[];
}

export interface ClosedBasketLeg {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  entryPrice: number;
  exitPrice?: number | null;
  bookedPnl: number | null;
  exitSource?: string | null;
  exitAt?: string | null;
  exitNote?: string | null;
}

export interface ClosedAutomatedRun {
  id: string;
  name: string;
  realized: number;
  closedAt: string | null;
  legs: ClosedRunLeg[];
}

export interface ClosedRunLeg {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  entryPrice: number;
  exitPrice: number | null;
  realizedPnl: number | null;
}

export interface ClosedSingleTrade {
  symbol: string;
  exchange: string;
  product: string;
  side: "BUY" | "SELL";
  quantity: number;
  entryPrice: number | null;
  exitPrice: number | null;
  realizedPnl: number | null;
  closedAt: string | null;
  provider: string;
  account: string;
  basket: string | null;
  source: string;
}