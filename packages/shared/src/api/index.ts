/**
 * API Layer - Shared between web and mobile
 *
 * Exports:
 * - createApiClient: Factory for creating configured API clients
 * - createApiHooks: Factory for creating TanStack Query hooks
 * - api: Pre-configured hooks using default client (for convenience)
 * - queryKeys: Consistent cache key factory
 * - useQuotesStream: WebSocket hook for real-time quotes
 * - Types: All request/response types
 */

export {
  createApiClient,
  type ApiClient,
  type ApiConfig,
  type ApiError,
  type RequestOptions,
  type HttpMethod,
  type PaginatedResponse,
} from "./client";

import { createApiHooks, type ApiHooks } from "./hooks";
import type { ApiClient } from "./client";
import type { QueryClient } from "@tanstack/react-query";

export {
  createApiHooks,
  queryKeys,
  BUILTIN_LISTS,
  QUALITY_WORD,
  indexStripRows,
  nearestMonthlyExpiry,
  todayIST,
  iciciHoldings,
  iciciOrders,
  iciciAccountSection,
  chartInstrument,
  chartRequest,
  chartFailureReason,
  chartPickerSections,
  type User,
  type BrokerStatus,
  type LoginRequest,
  type LoginResponse,
  type BasketListResponse,
  type Basket,
  type BasketLeg,
  type PayoffLeg,
  type UnattributedLeg,
  type BasketWorking,
  type BasketCharges,
  type ExitLegRequest,
  type ExitLegResult,
  type CloseBasketRequest,
  type CloseBasketResult,
  type RecordExitPriceRequest,
  type RemoveLegRequest,
  type BackfillRequest,
  type BackfillResponse,
  type OpenPosition,
  type Holding,
  type AccountSectionKind,
  type IciciAccountPayload,
  type IciciSection,
  type ClosedPosition,
  type WatchlistRow,
  type WatchlistInfo,
  type WatchlistPage,
  type WatchlistAdd,
  type BuiltinListName,
  type SecuritySearch,
  type OptionChainData,
  type SpotQuote,
  type OptionRow,
  type OptionQuote,
  type QuoteQuality,
  type UnderlyingInfo,
  type UnderlyingList,
  type StrategyAnalysis,
  type StrategyAnalysisRequest,
  type StrategyAnalysisLeg,
  type MarginRequest,
  type MarginRequestLeg,
  type MarginEstimate,
  type OrderIntent,
  type OrderLine,
  type BrokerLiveOrder,
  type BrokerOrder,
  type GttOrder,
  type PlaceOrderRequest,
  type PlaceOrderLine,
  type OptionDraftLeg,
  type OptionDraftsRequest,
  type OptionDraftsResponse,
  type OrderSnapshot,
  type EquityQuote,
  type OrderDestination,
  type OrderDestinations,
  type OrderResponse,
  type MarketQuote,
  type IndexQuote,
  type IndexStrip,
  type MarketDepth,
  type DepthLevel,
  type Automation,
  type LiveTrade,
  type ScannerSignal,
  type ScannerSignalType,
  type TechnicalEventsResponse,
  type FleetItem,
  type RunHealth,
  type ManagedRun,
  type ManagedRunsResponse,
  type ManagedBasketLeg,
  type StrategySetup,
  type StrategyDraftSummary,
  type DraftDetail,
  type LiveReadiness,
  type LiveStartRequest,
  type LiveStartResult,
  type Draft,
  type DraftLeg,
  type ChartData,
  type Candle,
  type HistoryResponse,
  type ClosedBasketView,
  type ClosedBasketLeg,
  type ClosedAutomatedRun,
  type ClosedRunLeg,
  type ClosedSingleTrade,
} from "./hooks";

export {
  useQuotesStream,
  useQuoteFeed,
  watchQuotes,
  type QuoteTick,
  type FeedSnapshot,
  type FeedReason,
  type UseQuotesStreamOptions,
  type UseQuotesStreamReturn,
} from "./websocket";

export {
  useLiveCandles,
  bucketStart,
  applyTick,
  foldBucket,
  streamId,
  symbolFromStreamId,
  tickBarInput,
  tickLabel,
  istDayStart,
  type ChartBucket,
  type LiveCandles,
} from "./live-candles";

export {
  strikeIds,
  watchBand,
  tickByInstrument,
  tickWord,
  tickBeats,
  liveSide,
  type Band,
  type LiveSide,
} from "./chain-ticks";

export {
  streamIdFor,
  derivativeCodes,
  markPositions,
  markHoldings,
  markWatchlist,
  type RowIdentity,
  type Marked,
} from "./account-quotes";

export {
  rupees,
  isLiveRun,
  isLiveMoney,
  openLiveBaskets,
  basketPnl,
  sameContract,
  withBookMarks,
  expiryKey,
  payoffExpiries,
  ladderUnderlying,
  buildAnalysis,
  priceProvenance,
  curves,
  valueAt,
  heldPayoff,
  payoffFigures,
  legValue,
  closedUnits,
  type AnalysisBuild,
  type HeldPayoff,
  type LegMark,
} from "./basket-desk";

export {
  nextSort,
  sortRows,
  type SortColumn,
  type SortState,
} from "./table-sort";

// Create default client and hooks for convenience
let api: ApiHooks | null = null;

export function getApi(): ApiHooks {
  if (!api) {
    throw new Error("API not initialized. Call initializeApi() first.");
  }
  return api;
}

/** Register an already-configured client (tokens, base URL) as the shared hook source.
 *  `queryClient` must be the instance the app gives `QueryClientProvider`: these hooks clear and
 *  invalidate the cache a mutation disturbs from outside React, so a second client of their own would
 *  leave every refresh after a send landing where no screen reads. */
export function configureApi(client: ApiClient, queryClient: QueryClient): ApiHooks {
  api = createApiHooks(client, queryClient);
  return api;
}

export function initializeApi(queryClient: QueryClient, baseUrl?: string, wsUrl?: string): ApiHooks {
  // A client registered with configureApi() already carries token storage; never replace it.
  if (api) return api;

  const { createApiClient } = require("./client");
  const { Constants } = require("../constants");
  
  const client = createApiClient({
    baseUrl: baseUrl || Constants.API.BASE_URL,
    wsUrl: wsUrl || Constants.API.WS_URL,
    getToken: async () => null,
    setToken: async () => {},
    clearToken: async () => {},
  });
  
  api = createApiHooks(client, queryClient);
  return api;
}