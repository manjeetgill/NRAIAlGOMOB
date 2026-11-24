/**
 * Where a screen that a row or a pill pushed goes when its own arrow is pressed.
 *
 * Popping back into the tab group does not restore the tab the trader left: a stock opened from the
 * Watchlist came back on More, and so did the search screen opened from Orders. So each screen names the
 * route it returns to, and the name is checked against the list below - a link or a mistyped parameter can
 * then never steer the app somewhere the router does not have.
 */

const RETURN_ROUTES = [
  "/(tabs)/portfolio",
  "/(tabs)/watchlist",
  "/(tabs)/orders",
  "/(tabs)/option-chain",
  "/(tabs)/more",
  // A stock opened from the search returns to the results the trader was reading, which stay mounted
  // beneath it, and the search's own arrow then goes to the tab the pill was pressed on.
  "/search",
] as const;

const DEFAULT_ROUTE = "/(tabs)/watchlist";

/** Accepts what `usePathname()` reports ("/watchlist") and what a route file writes ("/(tabs)/watchlist"). */
export function tabRoute(param: string | string[] | undefined): string {
  const raw = Array.isArray(param) ? param[0] : param;
  const name = String(raw ?? "").trim().replace(/^\/?\(tabs\)\//, "").replace(/^\//, "").toLowerCase();
  if (!name) return DEFAULT_ROUTE;
  return RETURN_ROUTES.find((route) => route.endsWith(`/${name}`)) ?? DEFAULT_ROUTE;
}
