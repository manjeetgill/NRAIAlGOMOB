const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..", "..");

const config = getDefaultConfig(projectRoot);

// Allow .txt files to be loaded as raw assets (for klinecharts library)
config.resolver.assetExts = [...config.resolver.assetExts, "txt"];

// babel aliases resolve into ../../packages/shared/src, which is outside projectRoot
config.watchFolders = [path.resolve(workspaceRoot, "packages")];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
