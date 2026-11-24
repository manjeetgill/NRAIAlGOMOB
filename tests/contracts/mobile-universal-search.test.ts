import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { tabRoute } from "../../apps/mobile/src/utils/tabRoute.ts";

/**
 * The universal search is one box on top of every screen that answers with the server's own listed-stock
 * catalogue, and a hit opens the stock's Overview. What matters here is what it must never do: widen the
 * catalogue to indices the trader cannot buy as a stock, invent a row the server did not return, or leave
 * a failed read looking like an empty search.
 */

const screen = readFileSync(resolve("apps/mobile/app/search.tsx"), "utf8");
const bar = readFileSync(resolve("apps/mobile/src/components/SearchBar.tsx"), "utf8");
const shell = readFileSync(resolve("apps/mobile/app/_layout.tsx"), "utf8");
const hooks = readFileSync(resolve("packages/shared/src/api/hooks.ts"), "utf8");

it("asks the equities catalogue and never the index list", () => {
  expect(hooks).toContain('client.get<SecuritySearch>("/v1/equities/search", { params: { q: query.trim() } })');
  expect(screen).not.toContain("include_indices");
  expect(screen).not.toContain("alert_search");
});

it("is reached from every screen but the sign-in and the search itself", () => {
  expect(shell).toContain("{pathname !== \"/login\" && pathname !== \"/search\" ? <SearchBar /> : null}");
  expect(bar).toContain('router.push(`/search?tab=${encodeURIComponent(pathname)}`)');
});

it("opens the Overview of the exact hit the trader tapped", () => {
  expect(screen).toContain("const openOverview = (hit: { exchange: string; symbol: string }) => {");
  expect(screen).toContain("`/stock?exchange=${encodeURIComponent(hit.exchange)}&symbol=${encodeURIComponent(hit.symbol)}&tab=search`");
  expect(screen).toContain("onPress={() => openOverview(item)}");
});

it("waits for two letters instead of firing a read at every keystroke", () => {
  expect(screen).toContain("const MIN_QUERY = 2;");
  expect(screen).toContain("const timer = setTimeout(() => setDebounced(text), 250);");
  expect(screen).toContain("Type at least ${MIN_QUERY} letters");
});

it("says when nothing matched, in the same breath as the query it searched", () => {
  expect(screen).toContain("`No listed stock matches “${query}”.`");
});

it("gives prod's own reason when the catalogue could not be searched, not a blank list", () => {
  expect(screen).toContain('chartFailureReason(error, "The listed-stock catalogue could not be searched. Retry shortly.")');
});

it("shows which catalogue was searched and how big it is", () => {
  expect(screen).toContain("{`Listed stocks searched: ${formatNumber(data.catalogueTotal, 0)} · source ${data.source}`}");
});

it("draws only the fields the server sent for a hit", () => {
  expect(screen).toContain("keyExtractor={(hit) => `${hit.exchange}:${hit.symbol}`");
  expect(screen).toContain("{item.symbol}");
  expect(screen).toContain("{item.name ? <Text");
  expect(screen).toContain("<Text style={styles.venue}>{item.exchange}</Text>");
});

/** A notification or a link can open either screen as the first route in the stack. Pressing back there
 *  used to throw an unhandled GO_BACK, and popping back into the tab group restored the More tab whatever
 *  the trader came from. Both arrows now navigate to the tab named by the `tab` parameter, or replace the
 *  screen with it when there is nothing to pop at all. */
it("returns to the tab the trader came from and never throws", () => {
  const overview = readFileSync(resolve("apps/mobile/app/stock.tsx"), "utf8");
  for (const source of [screen, overview]) {
    expect(source).toContain("canGoBack ? router.navigate(backTo) : router.replace(backTo)");
    expect(source).toContain("tabRoute(");
    expect(source).toContain("onPress={goBack}");
    expect(source).not.toContain("onPress={() => router.back()}");
  }
});

/** The destination is whatever the caller put in the URL, and a link is user input: only the five tabs and
 *  the search may be named, anything else falls back to the Watchlist rather than a route the router does
 *  not have. */
it("accepts only a route the app actually has", () => {
  expect(tabRoute("portfolio")).toBe("/(tabs)/portfolio");
  expect(tabRoute("/watchlist")).toBe("/(tabs)/watchlist");
  expect(tabRoute("(tabs)/orders")).toBe("/(tabs)/orders");
  expect(tabRoute("option-chain")).toBe("/(tabs)/option-chain");
  expect(tabRoute("search")).toBe("/search");
  for (const junk of [undefined, "", "stock", "../../admin", "PORTFOLIO?x=1", "'] ;"]) {
    expect(tabRoute(junk)).toBe("/(tabs)/watchlist");
  }
});
