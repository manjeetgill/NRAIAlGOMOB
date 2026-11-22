import { defineConfig } from "vitest/config";

// These are the app's only automated proof. Each suite imports the shared API layer exactly the way a screen
// does, so a prod route, a candle rule or a broker state word that moves without the contract agrees turns red
// here instead of on a device. The environment is node on purpose: nothing here renders a view.
export default defineConfig({
  test: {
    include: ["tests/contracts/**/*.test.ts"],
    environment: "node",
  },
});
