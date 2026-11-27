import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

/**
 * The launcher icon is the only piece of this app a user sees before opening it, and it was the stock Expo
 * placeholder for the whole project's life. Two things quietly undo a real icon here, so both are pinned:
 * `expo prebuild` re-emits the placeholder unless app.json names the source art, and Android 8+ ignores the
 * square bitmaps entirely unless an adaptive icon exists whose foreground fits the masked safe zone.
 */

const MOBILE = resolve(__dirname, "../../apps/mobile");
const RES = resolve(MOBILE, "android/app/src/main/res");
const DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"] as const;

const config = JSON.parse(readFileSync(resolve(MOBILE, "app.json"), "utf8")).expo;
const android = config.android as Record<string, any>;

it("names the artwork in app.json so a prebuild cannot fall back to the placeholder", () => {
  expect(android.icon).toBe("./assets/icon.png");
  expect(android.adaptiveIcon.foregroundImage).toBe("./assets/icon-maskable.png");
  expect(existsSync(resolve(MOBILE, "assets/icon.png"))).toBe(true);
  expect(existsSync(resolve(MOBILE, "assets/icon-maskable.png"))).toBe(true);
});

it("ships an adaptive icon, because Android masks the square bitmaps away on its own", () => {
  for (const name of ["ic_launcher", "ic_launcher_round"]) {
    const xml = readFileSync(resolve(RES, `mipmap-anydpi-v26/${name}.xml`), "utf8");
    expect(xml).toContain("<adaptive-icon");
    expect(xml).toContain('@mipmap/ic_launcher_foreground');
    expect(xml).toContain("@color/ic_launcher_background");
  }
});

it("keeps the one background colour agreed in both places it is declared", () => {
  const colors = readFileSync(resolve(RES, "values/colors.xml"), "utf8");
  const declared = colors.match(/<color name="ic_launcher_background">(#[0-9A-Fa-f]{6})<\/color>/);
  expect(declared, "values/colors.xml must declare ic_launcher_background").not.toBeNull();
  expect(declared![1].toUpperCase()).toBe(android.adaptiveIcon.backgroundColor.toUpperCase());
});

it("carries a real bitmap at every density, not just the one the build machine happens to use", () => {
  for (const dpi of DENSITIES) {
    for (const file of ["ic_launcher.webp", "ic_launcher_round.webp", "ic_launcher_foreground.webp"]) {
      const path = resolve(RES, `mipmap-${dpi}`, file);
      expect(existsSync(path), `${dpi}/${file} is missing`).toBe(true);
      expect(readFileSync(path).length, `${dpi}/${file} is empty`).toBeGreaterThan(512);
    }
  }
});

it("shows the same mark at launch that it shows on the home screen", () => {
  const splash = (config.plugins as unknown[]).find(
    (entry) => Array.isArray(entry) && entry[0] === "expo-splash-screen",
  ) as [string, Record<string, unknown>] | undefined;
  expect(splash, "expo-splash-screen must be configured in app.json").toBeTruthy();
  expect(splash![1].image).toBe("./assets/splash.png");
  expect(splash![1].backgroundColor).toBe(android.adaptiveIcon.backgroundColor);

  const colors = readFileSync(resolve(RES, "values/colors.xml"), "utf8");
  expect(colors).toContain('<color name="splashscreen_background">#00164A</color>');
  expect(existsSync(resolve(MOBILE, "assets/splash.png"))).toBe(true);
  for (const dpi of DENSITIES) {
    expect(existsSync(resolve(RES, `drawable-${dpi}/splashscreen_logo.png`)), `${dpi} splash is missing`).toBe(true);
  }

  // A bitmap used as android:windowBackground is scaled to fill the whole window, which smears a square
  // mark across the screen. The SplashScreen API centres and masks it instead.
  const styles = readFileSync(resolve(RES, "values/styles.xml"), "utf8");
  expect(styles).toContain('name="Theme.App.SplashScreen" parent="Theme.SplashScreen"');
  expect(styles).toContain('<item name="windowSplashScreenAnimatedIcon">@drawable/splashscreen_logo</item>');
  expect(styles).toContain('<item name="postSplashScreenTheme">@style/AppTheme</item>');
  expect(styles).not.toContain("android:windowBackground");
});
