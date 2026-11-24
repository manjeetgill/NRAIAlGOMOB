# PROJECT_UNDERSTANDING.md
# NRAIAlgo Mobile (MyAlgoDesk) - Senior Technical Architecture & Codebase Discovery Report

**Document Date:** November 2026  
**Audience:** Senior Technical Lead / Engineering Leadership  
**Author:** Senior Software Architect  
**Scope:** `mobile-app` workspace within the `NRAIAlgo-Python` ecosystem  

---

## 1. Executive Project Summary

**MyAlgoDesk Mobile (NRAIAlgo Mobile)** is a cross-platform financial trading and analytics mobile application built using **React Native (0.88.1)**, **Expo SDK (58)** with **Expo Router**, **TypeScript**, and **NativeWind / Tailwind CSS**. It connects to the high-performance **MyAlgoDesk / NRAIAlgo** algorithmic trading platform backend (FastAPI, PostgreSQL 17, and an execution worker daemon).

The application enables Indian retail and proprietary options traders to monitor and execute trades on the go across major Indian exchanges (**NSE, NFO, BSE, BFO, MCX**). Key business capabilities include:
- **Real-time Portfolio & Broker Account Surveillance:** Unified view of live positions, delivery holdings, and cash margins across multiple broker accounts (primarily ICICI Direct Breeze API, Zerodha Kite Connect, and Kotak Securities).
- **Advanced Options Desk & Spread Builder:** Construction and execution of complex multi-leg options strategies (Straddles, Strangles, Iron Condors, Butterflies, Calendar Spreads) with server-calculated T+0 vs. Expiry payoff curves, Greeks, and margin estimations.
- **Dynamic Option Chain Ladder:** High-density options ladder displaying real-time strike premiums, Greeks (Delta, IV), and bid/ask spreads with automated visible-window WebSocket subscription management.
- **Real-Time Technical Scanner & Strategy Fleet:** Live feed of breakout/breakdown signals, support/resistance alerts, and live monitoring of automated algorithmic strategy instances ("fleet").
- **Interactive Financial Candlestick Charts:** Offline-capable, high-performance candlestick charts powered by a locally bundled `klinecharts` library embedded in a React Native WebView, synthesized with live forming bars from streaming ticks.

---

## 2. Technology Stack Breakdown

| Layer | Technologies / Libraries | Purpose & Implementation Details |
|---|---|---|
| **Mobile Framework** | React Native 0.88.1, React 19.3.0, Expo ~58.0.26 | Cross-platform runtime running on the New Architecture / Hermes engine. |
| **Routing & Navigation** | Expo Router ~58.0.32 | File-based routing under `apps/mobile/app` with typed navigation, tab layouts, and deep link resolution. |
| **Monorepo Architecture** | npm workspaces (`apps/*`, `packages/*`) | Separates UI applications (`apps/mobile`, placeholder `apps/web`) from platform-agnostic business logic (`packages/shared`). |
| **State Management** | Zustand ^5.0.15 | Decoupled stores for Authentication (`useAuthStore`), UI/Theme (`useUIStore`), and Trading/Tickets (`useTradingStore`) with persistence middleware. |
| **Server State & Caching**| TanStack React Query ^5.104.0 | Server data synchronization, windowing cache invalidation, automated polling intervals, and optimistic updates. |
| **Styling & Theming** | NativeWind ^4.1.0, Tailwind CSS ^3.4.0, StyleSheet | Dynamic dark/light theme switching with strict financial color semantic guidelines (IST-oriented, P&L greens/reds). |
| **Data Visualization** | `klinecharts.min.js` (WebView), `react-native-svg` ^15.16.0, `react-native-gifted-charts` ^1.4.83 | Embedded WebView for multi-indicator candlestick charting; pure SVG paths for mathematical options payoff curves. |
| **Hardware & Native APIs** | Expo SecureStore, LocalAuthentication, Notifications, NetInfo | Token encryption in Android Keystore/iOS Keychain, biometric authentication, push notifications, network status. |
| **Backend API & Service** | Python FastAPI, Caddy Reverse Proxy, PostgreSQL 17 | REST API (`/v1/*`) and single-multiplexed WebSocket (`/v1/quotes/stream`) running at `https://myalgodesk.in`. |
| **Testing Framework** | Vitest ^5.1.1 | Headless Node.js contract test runner enforcing strict schema and behavioural contracts against UI screens and shared APIs. |

---

## 3. Architecture & Data Flow Breakdown

```
+---------------------------------------------------------------------------------------+
|                                    MOBILE APPLICATION                                 |
|                                                                                       |
|   apps/mobile/app (Expo Router Screens)                                               |
|   +-------------------+  +-------------------+  +-------------------+  +------------+ |
|   |  (tabs)/portfolio |  |  (tabs)/watchlist |  | (tabs)/opt-chain |  |  (tabs)/   | |
|   |  - Positions      |  |  - Built-in NSE   |  | - Strike Ladder   |  |   orders   | |
|   |  - Holdings       |  |  - 5 Custom Lists |  | - Visible Band    |  |  - Open    | |
|   +-------------------+  +-------------------+  +-------------------+  |  - Closed  | |
|   +-------------------+  +-------------------+                         |  - GTT     | |
|   |  spread-builder   |  |  terminal-charts  |                         +------------+ |
|   |  - BasketDesk.tsx |  |  - KLineChart.tsx |                                        |
|   |  - T+0 & Expiry   |  |  - Live Forming   |                                        |
|   +-------------------+  +-------------------+                                        |
|             |                      |                                                  |
|             v                      v                                                  |
|   packages/shared (Shared Business Core)                                              |
|   +-------------------+  +-------------------+  +-------------------+                 |
|   | api/client.ts     |  | api/websocket.ts  |  | api/live-candles.ts|                 |
|   | - Cookie Session  |  | - Single Conn.    |  | - IST Sessions    |                 |
|   | - Bearer Auth     |  | - Multiplex Sub   |  | - Bar formation   |                 |
|   +-------------------+  +-------------------+  +-------------------+                 |
|   +-------------------+  +-------------------+  +-------------------+                 |
|   | stores/           |  | api/hooks.ts      |  | api/basket-desk.ts|                 |
|   | - Auth / Trading  |  | - TanStack Queries|  | - Payoff engine   |                 |
|   +-------------------+  +-------------------+  +-------------------+                 |
+---------------------------------------------------------------------------------------+
                     | REST (HTTPS)                           | WebSocket (WSS)
                     v                                        v
+---------------------------------------------------------------------------------------+
|                                 BACKEND (MyAlgoDesk)                                  |
|   FastAPI Gateway (Caddy) @ https://myalgodesk.in                                     |
|   - /v1/auth/*        - /v1/option-chain        - /v1/strategy-analysis               |
|   - /v1/baskets       - /v1/orders/*            - /v1/quotes/stream                   |
|                                                                                       |
|   PostgreSQL 17 Database <------> Execution Worker Daemon <------> Broker APIs        |
|   (Accounts, States, Baskets)    (Order Queue, Reconciliation)   (ICICI, Zerodha, ...) |
+---------------------------------------------------------------------------------------+
```

### Critical Architectural Pillars & Data Flows

1. **Session-Cookie Identity Architecture:**
   - Unlike standard JWT-only SPAs, the production platform (`myalgodesk.in`) authenticates via an HTTP-only session cookie.
   - `client.ts` strictly enforces `credentials: "include"`, ensuring native cookie jars store and replay session credentials on all REST calls.
   - Initial verification occurs via `/v1/auth/me`. If `/v1/auth/me` fails or rejects, the app clears cached credentials and returns to `/login`.

2. **Single-Socket Multiplexing (`packages/shared/src/api/websocket.ts`):**
   - The backend restricts quote stream connections to 3 active clients per workspace.
   - Multiple screens cannot open separate WebSockets. The mobile app implements a module-level singleton socket connection.
   - Screens register watch requests for canonical instrument identifiers (e.g., `instrument:v1:NSE:EQUITY:RELIANCE`). The socket aggregator takes the union of active subscriptions and sends a full replacement payload `{"type": "subscribe", "instruments": [...]}`.
   - Required handshake: The `origin` header must explicitly match `https://myalgodesk.in`, or the backend drops the socket with status `1008`.

3. **Visible Band Ladder Windowing (`packages/shared/src/api/chain-ticks.ts`):**
   - Options chains for underlying assets like NIFTY span hundreds of theoretical strikes. Subscribing to all strikes would choke network bandwidth and exhaust broker quota.
   - The app dynamically calculates the trader's viewport with padding (`BAND_PAD = 6`). Only strikes within this window are subscribed to live streaming quotes. Minor scrolls reuse the active band without firing new network subscriptions.

4. **Client-Side Live Candlestick Synthesis (`packages/shared/src/api/live-candles.ts`):**
   - The WebSocket stream transmits raw tick-level price events with exchange timestamps; it does not push pre-aggregated candle bars.
   - Historical completed bars are fetched once via REST (`/v1/charts/intraday`).
   - The mobile client continuously constructs the "forming candle" in memory using exact IST market hours (09:15 to 15:30 IST), adhering strictly to bucket boundaries (`1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `1d`).

5. **Idempotent Multi-Leg Execution (`packages/shared/src/hooks/useOrderTicket.tsx` & `spread-builder.tsx`):**
   - Multi-leg options baskets and single orders generate a unique client UUID v4 token (`newClientId()`).
   - The client reference is pinned to the staging session. Any subsequent retry or connection drop reuses this exact client ID, ensuring the backend idempotency guard prevents double-execution at the broker level.

---

## 4. Codebase Structure & Directory Breakdown

```
mobile-app/
├── package.json                   # Monorepo root config (npm workspaces: apps/*, packages/*)
├── vitest.config.mts              # Contract test runner configuration (Node.js environment)
├── tsconfig.json                  # Root TypeScript configuration
├── app.json                       # Root Expo configuration (points to com.anonymous.nraialgomobile)
├── apps/
│   ├── mobile/                    # Primary React Native / Expo application (@nraialgo/mobile)
│   │   ├── package.json           # Mobile package dependencies & scripts
│   │   ├── app.json               # Canonical Expo configuration (in.myalgodesk.mobile)
│   │   ├── babel.config.js        # Babel aliases for @/ and @nraialgo/shared
│   │   ├── metro.config.js        # Metro bundler config with watchFolders for packages/
│   │   ├── eas.json               # EAS build configurations (dev, preview APK, prod app-bundle)
│   │   ├── app/                   # Expo Router file-based screens
│   │   │   ├── _layout.tsx        # Root shell: QueryClient, ThemeProvider, IndexStrip, Safe Area
│   │   │   ├── index.tsx          # Auth gate redirect (/(tabs)/watchlist vs /login)
│   │   │   ├── login.tsx          # 2FA/MFA credential authentication screen
│   │   │   ├── (tabs)/            # Bottom Tab Navigator
│   │   │   │   ├── _layout.tsx    # Tab bar definition (Portfolio, Watchlist, Orders, Options, More)
│   │   │   │   ├── portfolio.tsx  # Sortable table for ICICI Positions & Holdings
│   │   │   │   ├── watchlist.tsx  # Built-in NSE lists + 5 Custom Trader Watchlists
│   │   │   │   ├── orders.tsx     # Broker orders & GTT order surveillance
│   │   │   │   ├── option-chain.tsx# NIFTY/BankNIFTY/Stock Options Ladder with Tick Feeds
│   │   │   │   ├── scanner.tsx    # Technical events scanner (Breakout/Breakdown/RSI)
│   │   │   │   └── more.tsx       # Account settings, broker links, advanced tool navigation
│   │   │   ├── spread-builder.tsx # Multi-leg option spread creator & payoff analyzer
│   │   │   ├── algo-lab.tsx       # Strategy condition staging & fleet monitoring
│   │   │   ├── terminal-charts.tsx# Fullscreen candlestick terminal with timeframes
│   │   │   └── trade-history.tsx  # Historical basket & single-trade audit logs
│   │   ├── src/
│   │   │   ├── components/        # Reusable UI components
│   │   │   │   ├── BasketDesk.tsx # Live options payoff viewer & adjustment tool
│   │   │   │   ├── BuySheet.tsx   # Slide-up fast execution ticket
│   │   │   │   ├── IndexStrip.tsx # Persistent top ticker (NIFTY, SENSEX, BANKNIFTY)
│   │   │   │   ├── KLineChart.tsx # WebView wrapper for local klinecharts library
│   │   │   │   ├── SortableTable.tsx# Generic column-sorted financial data table
│   │   │   │   ├── ThemeProvider.tsx# Dark/Light theme context & palette definitions
│   │   │   │   └── WatchlistManager.tsx# Modal sheet to switch/rename watchlists
│   │   │   ├── hooks/             # App-level hooks
│   │   │   │   ├── useApi.ts      # Component-safe accessor for @nraialgo/shared API
│   │   │   │   └── useRealtimeQuotes.ts # React Query cache mutator for live ticks
│   │   │   └── utils/
│   │   │       ├── apiClient.ts   # SecureStore token bindings for createApiClient
│   │   │       ├── queryClient.ts # TanStack Query configuration & hook registration
│   │   │       └── deepLinking.ts # Custom scheme & universal link parser
│   └── web/                       # Empty directory (reserved for future web workspace)
├── packages/
│   └── shared/                    # Platform-agnostic TypeScript core library (@nraialgo/shared)
│       ├── package.json           # Shared library manifest
│       └── src/
│           ├── index.ts           # Re-exports all submodules
│           ├── api/
│           │   ├── client.ts      # Fetch wrapper with timeout, cookies, error parsing
│           │   ├── websocket.ts   # Singleton quote stream manager & tick parser
│           │   ├── hooks.ts       # React Query hooks for every /v1/* REST endpoint
│           │   ├── basket-desk.ts # Pure math: payoff curves, leg valuation, ladders
│           │   ├── chain-ticks.ts # Dynamic band-subscription algorithm
│           │   ├── live-candles.ts# IST candle aggregation engine
│           │   └── table-sort.ts  # Financial table sorting logic
│           ├── constants/index.ts # Endpoints, broker names, product codes, IST hours
│           ├── hooks/
│           │   ├── index.ts       # Shared React hooks
│           │   └── useOrderTicket.tsx # Universal ticket state & execution flow
│           ├── stores/index.ts    # Zustand stores (Auth, UI, Trading)
│           └── utils/index.ts     # Pure functions: IST dates, currency formatting, math
└── tests/
    └── contracts/                 # Contract test suite (9 test suites, 139 tests)
        ├── mobile-basket-desk.test.ts
        ├── mobile-chain-ticks.test.ts
        ├── mobile-live-book.test.ts
        ├── mobile-live-chart.test.ts
        ├── mobile-orders-tabs.test.ts
        ├── mobile-portfolio-table.test.ts
        ├── mobile-portfolio.test.ts
        ├── mobile-terminal-chart.test.ts
        └── mobile-watchlist-ticks.test.ts
```

---

## 5. Critical Workflows & Execution Paths

### 1. Authentication & Session Initialization
- **Path:** `apps/mobile/app/login.tsx` -> `packages/shared/src/api/client.ts`
- **Execution:**
  1. User submits `email` and `password` to `/v1/auth/login`.
  2. If MFA is enabled on the account, the server returns `{ mfaRequired: true }`. The UI dynamically reveals the 6-digit TOTP input.
  3. On successful credentials submission, the server sets an HTTP session cookie.
  4. The client issues an immediate verification call to `/v1/auth/me`. Only upon receiving valid `User` data is `useAuthStore.setUser(user)` invoked.
  5. Tokens are persisted via `expo-secure-store`, and the router navigates to `/(tabs)/portfolio`.

### 2. Live Market Data Ticker Streaming
- **Path:** `IndexStrip.tsx` / `watchlist.tsx` / `option-chain.tsx` -> `useQuoteFeed` -> `websocket.ts`
- **Execution:**
  1. Screen identifies symbols to track (e.g., `["NIFTY 50", "NIFTY BANK"]`).
  2. Symbols are converted to canonical IDs (`instrument:v1:NSE:INDEX:NIFTY+50`).
  3. `websocket.ts` registers a `Watcher`, calculates the union of all active watchers, and transmits `{ type: "subscribe", instruments: [...] }` over the persistent WebSocket.
  4. Incoming tick frames are normalized into `QuoteTick` structures.
  5. `useRealtimeQuotes` directly mutates the TanStack Query cache (`queryClient.setQueryData(["positions", "open", "all"], ...)`), updating rendered P&L numbers without triggering network refetches.

### 3. Options Spread Builder & Adjustment
- **Path:** `apps/mobile/app/spread-builder.tsx` -> `BasketDesk.tsx` -> `packages/shared/src/api/basket-desk.ts`
- **Execution:**
  1. User builds or selects an option strategy (e.g., Short Strangle: Sell 25600 CE, Sell 25600 PE).
  2. `basket-desk.ts` constructs an `AnalysisBuild` containing the underlying spot, interest rate, days to expiry, and legs.
  3. A POST request is dispatched to `/v1/strategy-analysis`. The backend returns the mathematical T+0 curve and expiry payoff matrix.
  4. In parallel, `/v1/option-chain/margin` estimates broker margin requirements.
  5. The payoff curve is rendered via `react-native-svg`.
  6. Upon trader confirmation, the basket draft is resolved via `/v1/orders/option-drafts` and placed through `/v1/orders` using an idempotent `newClientId()`.

---

## 6. Code Quality, Technical Debt, and Risks Identified

### A. Failing Automated Contract Tests (6 Failures)
During our verification run of `npm test` (`vitest run`), **6 tests failed across 2 suites**:
1. **`tests/contracts/mobile-orders-tabs.test.ts` (5 Failures):**
   - *Issue:* The `orders.tsx` screen was recently refactored to fetch direct broker orders from `useIciciAccount` with tab IDs `"open"` / `"closed"` / `"gtt"`. The contract suite expects the tabs to be `"pending"` / `"executed"` / `"gtt"` mapped against the internal execution worker queue (`/v1/orders`) with status words like `queued`, `working`, `filled`, `cancelled`, and `refetchIntents`.
2. **`tests/contracts/mobile-basket-desk.test.ts` (1 Failure):**
   - *Issue:* A recent commit altered `BasketDesk.tsx`, removing the exact substring `basket.spot > 0` and `priceProvenance(built.marks)`. The contract test failed on `expect(desk).toContain("basket.spot > 0")`.

### B. Hidden TypeScript Compiler Errors in `@nraialgo/shared`
- Running `npm run typecheck` in the root workspace executes only `tsc --noEmit` in `@nraialgo/mobile`, which passes cleanly.
- Running `npm run typecheck --workspace @nraialgo/shared` fails with **2 TypeScript compilation errors**:
  1. `src/api/basket-desk.ts:322`: Type `{ body: ...; margin: { legs: MarginRequestLeg[]; } | null; ... }` is not assignable to `AnalysisBuild` because `margin` can be `null`, while the interface expects `MarginRequest`.
  2. `src/api/hooks.ts:324`: Return type mismatch in mutation function (`Promise<unknown>` cannot be assigned to `Promise<void>`).

### C. Dead Routes and Broken Navigation Links
1. **Missing `/backtesting` Route:**
   - In `apps/mobile/app/(tabs)/more.tsx` (line 152), the menu item triggers `router.push("/backtesting")`.
   - **No `/backtesting.tsx` file exists** in `apps/mobile/app/`. Tapping this button in production will throw an unhandled `Unmatched Route` error.
2. **Missing Deep Link Routes `/basket/[id]` and `/order/[id]`:**
   - In `apps/mobile/src/utils/deepLinking.ts` (lines 32-33), incoming URLs for `/basket` and `/order` map to `/basket/${params.id}` and `/order/${params.id}`.
   - **No dynamic route folders `app/basket/[id].tsx` or `app/order/[id].tsx` exist**.

### D. Duplicate Native Android Directories & Config Conflict
- The repository contains **two separate Android project directories**:
  1. `mobile-app/android/` (generated with package `com.anonymous.nraialgomobile` based on root `mobile-app/app.json`).
  2. `mobile-app/apps/mobile/android/` (generated with canonical package `in.myalgodesk.mobile` based on `apps/mobile/app.json`).
- *Root Cause:* Someone executed `expo prebuild` from the monorepo root directory instead of within `apps/mobile`. This creates developer confusion and bloats repository size.

### E. Leaky Shared Abstraction
- In `packages/shared/src/hooks/useOrderTicket.tsx`, line 18 directly imports `Alert` from `react-native`:
  ```typescript
  import { Alert } from "react-native";
  ```
- Because `@nraialgo/shared` is architected as the shared kernel for both native mobile and future web (`apps/web`), importing React Native primitives directly breaks clean cross-platform portability.

### F. Phantom Shared API Endpoints
- In `apps/mobile/app/trade-history.tsx`, the code documentation explicitly highlights that hooks `useHistory` and `useClosedPositions` in `@nraialgo/shared/src/api/hooks.ts` target REST endpoints that the FastAPI backend never implemented (`/v1/history`, `/v1/positions/closed`). Screen implementations have had to work around this by reading `/v1/baskets` and filtering locally.

---

## 7. Testing, Build, and CI/CD Verification

### Test Coverage
- **Contract Testing (`tests/contracts/`):** 9 test suites containing 139 tests.
  - The tests verify architectural adherence, AST/source text invariants, and shared mathematical calculations (IST bucket formulas, sorting rules, ladder windowing).
  - Current status: **133 Passed, 6 Failed**.
- **Unit & Component Testing:**
  - Currently **zero** Jest/React Native Testing Library unit tests exist for UI components (`IndexStrip`, `BuySheet`, `BasketDesk`, etc.).
  - There are no isolated test suites for Zustand stores.

### Build & Release Tooling
- **EAS Build (`apps/mobile/eas.json`):**
  - Configured for three build profiles: `development` (internal client), `preview` (standalone Android APK), and `production` (Google Play Store App Bundle `.aab`).
  - Target package identifier: `in.myalgodesk.mobile`.
  - Android SDK and Hermes engine enabled.

---

## 8. Senior Technical Lead Briefing & Actionable Roadmap

Welcome aboard as Senior Technical Lead! Here is the bottom-line summary of where this application stands and what requires your immediate direction:

### Current State Assessment
The core engineering in this codebase is remarkably sophisticated:
- Financial math (IST session handling, visible band ladder streaming, options payoff calculations) is rigorously designed to prevent broker quota exhaustion and inaccurate pricing.
- The state architecture handles volatile market tick streams without triggering high-frequency React component re-renders.
- However, rapid recent feature additions have caused drift between the implementation and the contract tests, along with orphan files and dead navigation links.

### Immediate Priority Backlog for the Team
1. **Reconcile Contract Tests & Orders Screen:**
   - Align with the product team on whether `orders.tsx` should display raw broker orders (`useIciciAccount`) or execution worker queued intents (`useOrderIntents`). Update either the UI or `mobile-orders-tabs.test.ts` accordingly.
   - Restore the missing `basket.spot > 0` and `priceProvenance` checks in `BasketDesk.tsx` or update `mobile-basket-desk.test.ts`.
2. **Fix `@nraialgo/shared` Typecheck & CI Pipeline:**
   - Fix the 2 TypeScript type mismatches in `basket-desk.ts` and `hooks.ts`.
   - Update the root `package.json` `"typecheck"` script to check both `@nraialgo/shared` and `@nraialgo/mobile`.
3. **Clean Up Broken Navigation & Routes:**
   - Either create the `/backtesting` screen or remove the navigation tile from `apps/mobile/app/(tabs)/more.tsx`.
   - Create route stubs for `/basket/[id]` and `/order/[id]` or sanitize `deepLinking.ts`.
4. **Prune Duplicate Android Artifacts & Monorepo Hygiene:**
   - Remove the accidental root-level `mobile-app/android` directory and root `app.json`. Retain only `apps/mobile/android` and `apps/mobile/app.json`.
   - Delete the 5 empty orphan directories in `packages/shared/` (`api`, `constants`, `schemas`, `stores`, `utils`).
5. **Decouple `@nraialgo/shared` from `react-native`:**
   - Abstract `Alert` in `useOrderTicket.tsx` behind a platform notification callback.
