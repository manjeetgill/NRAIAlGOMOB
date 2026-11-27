import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

/**
 * The More tab is where a trader goes to find out what the app can do, so a row there that opens nothing is
 * worse than a missing feature: it is a button that lies. These cases keep every row either pressable to a
 * screen the build contains or a fact the server actually reported, and they keep a deep link from naming a
 * route the app does not have.
 */

const more = readFileSync(resolve("apps/mobile/app/(tabs)/more.tsx"), "utf8");
const links = readFileSync(resolve("apps/mobile/src/utils/deepLinking.ts"), "utf8");
const hooks = readFileSync(resolve("packages/shared/src/api/hooks.ts"), "utf8");

/**
 * The opening tag of an element, scanned with brace depth and string state, because an arrow function in
 * `onPress={() => …}` contains a `>` that ends no tag.
 */
function openingTags(source: string, tag: string): string[] {
  const found: string[] = [];
  for (let at = source.indexOf(`<${tag}`); at !== -1; at = source.indexOf(`<${tag}`, at + 1)) {
    let depth = 0;
    let quote = "";
    let end = at;
    for (let i = at + tag.length + 1; i < source.length; i += 1) {
      const ch = source[i];
      if (quote) {
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) { end = i; break; }
    }
    found.push(source.slice(at, end + 1));
  }
  return found;
}

describe("No row pretends to go somewhere", () => {
  it("has no coming-soon alert left on the screen", () => {
    expect(more).not.toContain("showComingSoon");
    expect(more).not.toMatch(/Alert\.alert\(\s*"Coming Soon"/);
    expect(more).not.toContain("is under development and will be available");
  });

  it("leaves no drawn-but-inert control behind", () => {
    // The switch used to be mounted with value={true} and an empty handler, and the theme row was a plain
    // View with a chevron-shaped value next to it.
    expect(more).not.toMatch(/onValueChange=\{\(\) => \{\}\}/);
    expect(more).not.toContain("<Switch");
    expect(more).not.toContain("Show P&L Colors");
  });

  it("attaches a press handler to every touchable row", () => {
    const inert = openingTags(more, "TouchableOpacity").filter(tag => !/onPress\s*=/.test(tag));
    expect(inert).toEqual([]);
  });

  it("keeps a chevron only where a screen is pushed", () => {
    const chevrons = (more.match(/chevron-forward-outline/g) ?? []).length;
    const pushes = (more.match(/router\.push\(/g) ?? []).length;
    expect(chevrons).toBe(pushes);
  });

  it.each([
    ["/algo-lab", "Algo Lab"],
    ["/spread-builder", "Spread builder"],
    ["/terminal-charts", "Terminal charts"],
    ["/scanner", "Scanner"],
    ["/trade-history", "Trade history"],
  ])("still opens %s from the tools list", (route, label) => {
    expect(more).toContain(`router.push("${route}")`);
    expect(more).toContain(`<Text style={styles.label}>${label}</Text>`);
  });
});

describe("The theme actually changes", () => {
  it("presses the control that writes the persisted choice", () => {
    expect(more).toContain("useUIStore(state => state.setTheme)");
    expect(more).toContain("onPress={() => setTheme(choice.id)}");
  });

  it("offers the three modes the provider resolves", () => {
    for (const label of ["System", "Light", "Dark"]) expect(more).toContain(`"${label}"`);
    expect(more).toContain('{ id: "system"');
    expect(more).toContain('{ id: "light"');
    expect(more).toContain('{ id: "dark"');
  });

  it("renders the tab instead of spinning on an account read", () => {
    expect(more).not.toContain("ActivityIndicator");
    expect(more).not.toMatch(/if \(meLoading\)/);
  });

  it("lets the label give way on a narrow phone instead of pushing the choices off screen", () => {
    // React Native defaults every view to flexShrink: 0, so an unwritten row overflows on a 320pt screen.
    expect(more).toMatch(/labelRow: \{[^}]*flexShrink: 1/);
    expect(more).toMatch(/themeTrack: \{[^}]*flexShrink: 0/);
  });
});

describe("The account card says what the server said", () => {
  it("names each of the three read states instead of printing a dash", () => {
    expect(more).toContain('"Reading from myalgodesk.in…"');
    expect(more).toContain('"Could not be read just now"');
    expect(more).toContain('"No credentials saved"');
    expect(more).toContain('"Required at sign-in"');
    expect(more).not.toContain('": "—"');
  });

  it("reads only the fields /v1/auth/me returns", () => {
    // prod answers with email, displayName, mfaRequired, adminRole, hasBroker and visualDirection.
    expect(more).toContain("account.displayName || account.email");
    expect(more).toContain("account.hasBroker");
    expect(more).toContain("account.mfaRequired");
    expect(more).not.toContain("account.tier");
    expect(more).not.toContain("account.name");
  });

  it("drops the plan and broker list the route never sends from the shared type", () => {
    const user = hooks.slice(hooks.indexOf("export interface User {"), hooks.indexOf("export interface BrokerStatus"));
    expect(user).toContain("hasBroker?: boolean");
    expect(user).toContain("mfaRequired?: boolean");
    expect(user).not.toContain("tier:");
    expect(user).not.toContain("brokers: string[]");
  });

  it("tells the trader where the actions the phone lacks live", () => {
    expect(more).toContain("Connecting a broker and changing two-factor settings happens on");
  });
});

describe("What the build reports about itself", () => {
  it("takes the version from the bundle, not from a string on screen", () => {
    expect(more).not.toContain("1.0.0 (Beta)");
    expect(more).toContain("Constants.expoConfig?.version");
    expect(more).toContain("build ${build}");
    expect(more).toContain('"Not reported by this build"');
  });

  it("names the server the requests go to", () => {
    expect(more).toContain("Constants.API?.BASE_URL");
    expect(more).toContain("new URL(url).host");
    expect(more).toContain("{host}");
  });

  it("keeps signing out local and says so", () => {
    expect(more).toContain("Sign out of this phone");
    expect(more).toContain("Your other devices stay signed in");
  });
});

describe("A deep link cannot name a route the app does not have", () => {
  const map = links.slice(links.indexOf("const ROUTE_MAP"), links.indexOf("};", links.indexOf("const ROUTE_MAP")));
  const targets = [...map.matchAll(/=>\s*["'`]([^"'`]+)/g)]
    .map(match => match[1].split(/[?$]/)[0])
    .filter(Boolean);

  it("reads every mapped destination out of the source", () => {
    expect(targets.length).toBeGreaterThanOrEqual(9);
  });

  it.each(targets)("resolves %s to a screen that exists", (target) => {
    const file = resolve("apps/mobile/app", target.replace(/^\//, "") + ".tsx");
    expect(existsSync(file)).toBe(true);
  });
});
