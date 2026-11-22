const path = require("path");

module.exports = function (api) {
  api.cache(true);

  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "module-resolver",
        {
          root: [],
          extensions: [".tsx", ".ts", ".js", ".jsx", ".json", ".android.tsx", ".ios.tsx", ".native.tsx"],
          alias: {
            "@": path.resolve(__dirname, "src"),
            "@nraialgo/shared": path.resolve(__dirname, "../../packages/shared/src"),
            "@nraialgo/shared/api": path.resolve(__dirname, "../../packages/shared/src/api/index.ts"),
            "@nraialgo/shared/hooks": path.resolve(__dirname, "../../packages/shared/src/hooks/index.ts"),
            "@nraialgo/shared/stores": path.resolve(__dirname, "../../packages/shared/src/stores/index.ts"),
            "@nraialgo/shared/utils": path.resolve(__dirname, "../../packages/shared/src/utils/index.ts"),
            "@nraialgo/shared/constants": path.resolve(__dirname, "../../packages/shared/src/constants/index.ts"),
          },
        },
      ],
    ],
  };
};
