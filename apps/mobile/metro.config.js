const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Monorepo: allow imports from workspace packages
config.watchFolders = [workspaceRoot, ...(config.watchFolders || [])];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// Keep Expo default behavior (doctor expects false). Monorepo resolution is handled via nodeModulesPaths/watchFolders.
config.resolver.disableHierarchicalLookup = false;

module.exports = config;



