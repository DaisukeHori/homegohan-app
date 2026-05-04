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

// Force single React 19 instance across the entire bundle.
// apps/mobile/node_modules/react = 19.0.0 (correct for this app)
// workspace root node_modules/react = 18.3.1 (hoisted for web packages)
// Without this, expo-router (loaded from workspace root) imports react 18.3.1
// while app code uses react 19.0.0, causing "Cannot read property 'S' of undefined".
const mobileNodeModules = path.resolve(projectRoot, "node_modules");
const REACT_PREFIXES = ["react", "react-dom", "react/", "react-dom/"];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isReact = REACT_PREFIXES.some(
    (p) => moduleName === p.replace(/\/$/, "") || moduleName.startsWith(p)
  );
  if (isReact) {
    // Always resolve react/react-dom from apps/mobile (React 19) regardless of caller location
    const resolveFrom = require("resolve-from");
    try {
      const resolved = resolveFrom(mobileNodeModules, moduleName);
      return { type: "sourceFile", filePath: resolved };
    } catch (_) {
      // fall through to default resolution
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
