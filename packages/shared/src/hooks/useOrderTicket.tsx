/**
 * Order Ticket Hook - Unified order entry from anywhere in the app
 *
 * Can be triggered from:
 * - Option Chain (buy/sell on strike)
 * - Global Search (select symbol)
 * - Basket (exit leg, add leg)
 * - Positions (close position)
 * - Watchlist (quick trade)
 * - Terminal Chart (trade from chart)
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useTradingStore } from "../stores";
import { getApi } from "../api";
import type { PlaceOrderLine, PlaceOrderRequest } from "../api";
import { formatRupees } from "../utils";
import { Alert } from "react-native";

/**
 * The two-way price a contract is actually quoted at. For an option this only ever comes from the
 * ladder the trader pressed: prod's single-symbol read answers for shares, not for NFO contracts.
 */
export interface OptionBook {
  bid: number | null;
  ask: number | null;
}

export interface OrderTicketConfig {
  symbol?: string;
  exchange?: string;
  product?: string;
  side?: "BUY" | "SELL";
  quantity?: number;
  orderType?: "MARKET" | "LIMIT" | "SL" | "SL-M";
  price?: number;
  triggerPrice?: number;
  validity?: "DAY" | "IOC";
  tag?: string;
  /** What the ticket prints as its title. The symbol field holds the token prod places, which for an option
   *  is the broker's master code and is not what a trader recognises. */
  label?: string;
  // Context for UI
  source?: "option-chain" | "global-search" | "basket" | "positions" | "watchlist" | "terminal" | "manual";
  basketId?: string;
  legId?: string;
  book?: OptionBook;
  onSuccess?: (orderId: string) => void;
  onError?: (error: Error) => void;
}

export interface OrderTicketState {
  symbol: string;
  exchange: string;
  product: string;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: "MARKET" | "LIMIT" | "SL" | "SL-M";
  price: number;
  triggerPrice: number;
  validity: "DAY" | "IOC";
  tag: string;
}

const DEFAULT_CONFIG: OrderTicketState = {
  symbol: "",
  exchange: "NSE",
  product: "CNC",
  side: "BUY",
  quantity: 1,
  orderType: "MARKET",
  price: 0,
  triggerPrice: 0,
  validity: "DAY",
  tag: "",
};

/**
 * A v4-shaped reference for one instruction. Hermes has no Web Crypto, and prod fences a manual
 * send on this value, so it is generated once per ticket and reused for every retry of that ticket:
 * a second reference under changed details would be a second order, not a retry.
 */
export function newClientId(): string {
  const hex = (count: number) =>
    Array.from({ length: count }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}

export function useOrderTicket() {
  // Read inside the hook, not at import time: the API is built once the provider is configured, and a
  // module-scope read would capture it before that or throw for a consumer that never opens a ticket.
  const { usePlaceOrder, useOrderDestinations } = getApi();
  const [visible, setVisible] = useState(false);
  const [config, setConfig] = useState<OrderTicketConfig | null>(null);
  const [localState, setLocalState] = useState<OrderTicketState>(DEFAULT_CONFIG);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const storedTicket = useTradingStore((s) => s.orderTicket);
  const setOrderTicketBatch = useTradingStore((s) => s.setOrderTicketBatch);
  const resetOrderTicket = useTradingStore((s) => s.resetOrderTicket);
  const { mutateAsync: placeOrder } = usePlaceOrder();
  // Which broker account the signed-in session would actually reach. Prod refuses an instruction
  // whose account does not match its live broker session, so a ticket cannot invent this.
  const { data: destinations } = useOrderDestinations(visible);
  const clientId = useRef(newClientId());

  // One direction only: this ticket's own edits go to the store, in one update, while it is open. Every
  // mounted ticket (watchlist, portfolio, chain...) used to also re-run on any store change and copy its own
  // values back, so two tickets overwrote each other forever. Reading the store happens only in open().
  const storedRef = useRef(storedTicket);
  storedRef.current = storedTicket;
  useEffect(() => {
    if (!visible) return;
    const stored = storedRef.current;
    const changes = Object.fromEntries(
      (Object.keys(localState) as Array<keyof OrderTicketState>)
        .filter((key) => stored[key] !== localState[key])
        .map((key) => [key, localState[key]]),
    ) as Partial<OrderTicketState>;
    if (Object.keys(changes).length > 0) setOrderTicketBatch(changes);
  }, [localState, visible, setOrderTicketBatch]);

  // Open order ticket with config
  const open = useCallback((newConfig: OrderTicketConfig) => {
    const mergedConfig = {
      ...DEFAULT_CONFIG,
      ...storedTicket,
      ...newConfig,
      side: newConfig.side || storedTicket.side || "BUY",
    };

    setConfig(newConfig);
    setLocalState({
      symbol: mergedConfig.symbol,
      exchange: mergedConfig.exchange,
      product: mergedConfig.product,
      side: mergedConfig.side,
      quantity: mergedConfig.quantity,
      orderType: mergedConfig.orderType,
      price: mergedConfig.price,
      triggerPrice: mergedConfig.triggerPrice,
      validity: mergedConfig.validity,
      tag: mergedConfig.tag,
    });
    setValidationError(null);
    setVisible(true);
  }, [storedTicket]);

  const close = useCallback(() => {
    setVisible(false);
    setConfig(null);
    setValidationError(null);
  }, []);

  // Validate form
  const validate = useCallback((): string | null => {
    const symbol = localState.symbol.trim();
    if (!symbol) return "Enter a symbol.";
    if (!/^[A-Z0-9&_-]{1,40}$/.test(symbol.toUpperCase())) return "A symbol is up to 40 letters, numbers, & _ or -.";
    if (!Number.isInteger(localState.quantity) || localState.quantity <= 0) return "Quantity must be a whole number above zero.";
    // Prod's order model has one price and no order type: every instruction leaves as a limit, so a
    // market or stop press here is refused instead of quietly sending something the owner did not mean.
    if (localState.orderType !== "LIMIT") return "This sends a limit order. Enter the price you will pay.";
    if (!(localState.price > 0)) return "Enter the price you will pay.";
    return null;
  }, [localState]);

  // Submit order
  const submit = useCallback(async () => {
    const error = validate();
    if (error) {
      setValidationError(error);
      Alert.alert("Check the ticket", error);
      return;
    }

    const account = destinations?.accounts?.[0];
    if (!account) {
      const message = "No connected broker account for this sign-in. Nothing was sent.";
      setValidationError(message);
      Alert.alert("Not sent", message);
      return;
    }

    setIsSubmitting(true);
    setValidationError(null);

    const payload: PlaceOrderRequest = {
      // One reference per ticket, reused by every retry of these details, so a slow answer can be
      // re-sent safely instead of becoming a second instruction.
      clientId: clientId.current,
      provider: account.provider,
      accountId: account.accountId,
      orders: [{
        tradingsymbol: localState.symbol.trim().toUpperCase(),
        exchange: localState.exchange as PlaceOrderLine["exchange"],
        side: localState.side,
        quantity: localState.quantity,
        product: localState.product as PlaceOrderLine["product"],
        price: localState.price.toFixed(2),
      }],
    };

    const label = `${localState.side} ${localState.quantity} ${payload.orders[0].tradingsymbol} at ${payload.orders[0].price}`;
    try {
      const result = await placeOrder(payload);
      const leg = result?.orders?.[0];
      config?.onSuccess?.(leg?.orderId ?? result.clientId);
      // Admission is not a fill: prod queues the instruction and the broker answers afterwards.
      Alert.alert("Sent to the broker",
        leg?.state === "filled"
          ? `${label} - filled.`
          : `${label}. The broker has the instruction; the outcome shows in Orders.`);
      close();
      resetOrderTicket();
      clientId.current = newClientId();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      config?.onError?.(err);
      // A deliberate refusal carries the server's own reason and means nothing was placed. A lost
      // answer does not: the same reference may still commit, so it must never invite a fresh press.
      const refused = typeof (error as { status?: number } | null)?.status === "number";
      Alert.alert(refused ? "Not accepted" : "Not confirmed",
        refused
          ? `${err.message} Nothing was sent.`
          : `${err.message} This instruction may still reach the broker. Do not send it again - check Orders.`);
    } finally {
      setIsSubmitting(false);
    }
  }, [localState, config, destinations, placeOrder, close, resetOrderTicket, validate]);

  // Quick actions for common scenarios
  const quickBuy = useCallback((symbol: string, exchange = "NSE", quantity = 1) => {
    open({ symbol, exchange, side: "BUY", quantity, orderType: "MARKET" });
  }, [open]);

  const quickSell = useCallback((symbol: string, exchange = "NSE", quantity = 1) => {
    open({ symbol, exchange, side: "SELL", quantity, orderType: "MARKET" });
  }, [open]);

  const quickLimitBuy = useCallback((symbol: string, price: number, exchange = "NSE", quantity = 1) => {
    open({ symbol, exchange, side: "BUY", quantity, orderType: "LIMIT", price });
  }, [open]);

  const quickLimitSell = useCallback((symbol: string, price: number, exchange = "NSE", quantity = 1) => {
    open({ symbol, exchange, side: "SELL", quantity, orderType: "LIMIT", price });
  }, [open]);

  const quickStopLossBuy = useCallback((symbol: string, triggerPrice: number, price: number, exchange = "NSE", quantity = 1) => {
    open({ symbol, exchange, side: "BUY", quantity, orderType: "SL", triggerPrice, price });
  }, [open]);

  const quickStopLossSell = useCallback((symbol: string, triggerPrice: number, price: number, exchange = "NSE", quantity = 1) => {
    open({ symbol, exchange, side: "SELL", quantity, orderType: "SL", triggerPrice, price });
  }, [open]);

  // From option chain
  const fromOptionChain = useCallback((
    underlying: string,
    strike: number,
    right: "CE" | "PE",
    expiry: string,
    side: "BUY" | "SELL",
    ltp?: number,
    book?: OptionBook,
    /** What the broker's own master calls the pressed contract, carried off the ladder row that offered it. */
    contract?: { symbol: string; exchange?: string | null } | null,
  ) => {
    // The readable string of a contract is not an order. Prod's model takes one uppercase token and its
    // placement stage matches that token against the broker's instrument master, so a spaced
    // "NIFTY 2026-11-26 25000 CE" could never be sent by any press. The row's own symbol is what places,
    // and the pieces stay in the tag for the screen that reads where a ticket came from.
    const label = `${underlying} ${expiry} ${strike} ${right}`;
    open({
      symbol: contract?.symbol || label,
      label,
      exchange: contract?.exchange || "NFO",
      product: "NRML",
      side,
      quantity: 1,
      orderType: ltp ? "LIMIT" : "MARKET",
      price: ltp || 0,
      tag: `option-chain:${underlying}`,
      source: "option-chain",
      book,
    });
  }, [open]);

  // From global search
  const fromGlobalSearch = useCallback((result: {
    symbol: string;
    name: string;
    exchange: string;
    type: "equity" | "index" | "option" | "future";
    ltp?: number;
  }) => {
    const productMap = {
      equity: "CNC",
      index: "NRML",
      option: "NRML",
      future: "NRML",
    };

    open({
      symbol: result.symbol,
      exchange: result.exchange,
      product: productMap[result.type] || "CNC",
      side: "BUY",
      quantity: 1,
      orderType: result.ltp ? "LIMIT" : "MARKET",
      price: result.ltp || 0,
      tag: `search:${result.name}`,
      source: "global-search",
    });
  }, [open]);

  // From basket
  const fromBasket = useCallback((
    basketId: string,
    leg: {
      symbol: string;
      side: "BUY" | "SELL";
      quantity: number;
      exchange: string;
      product: string;
      strike?: number;
      right?: "CE" | "PE";
      expiry?: string;
    },
    action: "exit" | "add" | "modify"
  ) => {
    const side = action === "exit" ? (leg.side === "BUY" ? "SELL" : "BUY") : leg.side;
    
    open({
      symbol: leg.symbol,
      exchange: leg.exchange,
      product: leg.product,
      side,
      quantity: leg.quantity,
      orderType: "LIMIT",
      price: 0,
      tag: `basket:${basketId}:${action}`,
      source: "basket",
      basketId,
    });
  }, [open]);

  // From positions
  const fromPosition = useCallback((position: {
    symbol: string;
    side: "BUY" | "SELL" | "OTHER";
    quantity: number;
    exchange: string;
    product: string;
    entryPrice: number | null;
  }) => {
    // Exit position - opposite side
    open({
      symbol: position.symbol,
      exchange: position.exchange,
      product: position.product,
      side: position.side === "BUY" ? "SELL" : "BUY",
      quantity: position.quantity,
      orderType: "LIMIT",
      price: 0,
      tag: `position:exit`,
      source: "positions",
    });
  }, [open]);

  return {
    // State
    visible,
    config,
    localState,
    isSubmitting,
    validationError,
    setLocalState,
    
    // Actions
    open,
    close,
    submit,
    validate,
    
    // Quick actions
    quickBuy,
    quickSell,
    quickLimitBuy,
    quickLimitSell,
    quickStopLossBuy,
    quickStopLossSell,
    
    // Context-specific openers
    fromOptionChain,
    fromGlobalSearch,
    fromBasket,
    fromPosition,
  };
}

// Context for global access without prop drilling
import { createContext, useContext, ReactNode } from "react";

interface OrderTicketContextValue {
  open: ReturnType<typeof useOrderTicket>["open"];
  quickBuy: ReturnType<typeof useOrderTicket>["quickBuy"];
  quickSell: ReturnType<typeof useOrderTicket>["quickSell"];
  fromOptionChain: ReturnType<typeof useOrderTicket>["fromOptionChain"];
  fromGlobalSearch: ReturnType<typeof useOrderTicket>["fromGlobalSearch"];
  fromBasket: ReturnType<typeof useOrderTicket>["fromBasket"];
  fromPosition: ReturnType<typeof useOrderTicket>["fromPosition"];
}

const OrderTicketContext = createContext<OrderTicketContextValue | null>(null);

export function OrderTicketProvider({ children }: { children: ReactNode }) {
  const ticket = useOrderTicket();
  
  return (
    <OrderTicketContext.Provider value={{
      open: ticket.open,
      quickBuy: ticket.quickBuy,
      quickSell: ticket.quickSell,
      fromOptionChain: ticket.fromOptionChain,
      fromGlobalSearch: ticket.fromGlobalSearch,
      fromBasket: ticket.fromBasket,
      fromPosition: ticket.fromPosition,
    }}>
      {children}
    </OrderTicketContext.Provider>
  );
}

export function useOrderTicketContext() {
  const context = useContext(OrderTicketContext);
  if (!context) {
    throw new Error("useOrderTicketContext must be used within OrderTicketProvider");
  }
  return context;
}