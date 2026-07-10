import { defineConfig } from "vitest/config";
import path from "node:path";
import fs from "node:fs";

// tsconfig paths: @/* → ./src/* AND ./*
// Vite alias does not support multiple fallback paths for a single key,
// so we use a custom resolver plugin that mimics Next.js/tsconfig behavior.
function atAliasPlugin() {
  const root = __dirname;
  return {
    name: "at-alias",
    resolveId(id: string) {
      if (!id.startsWith("@/")) return undefined;
      const rel = id.slice(2); // strip "@/"
      // try src/ first, then root
      for (const base of ["src", "."]) {
        for (const ext of ["", ".ts", ".tsx", ".js", ".jsx"]) {
          const candidate = path.join(root, base, rel + ext);
          if (fs.existsSync(candidate)) return candidate;
        }
        // index file inside directory
        for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
          const candidate = path.join(root, base, rel, "index" + ext);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [atAliasPlugin()],
  resolve: {
    alias: {
      "@homegohan/handson-tour-shared": path.resolve(
        __dirname,
        "packages/handson-tour-shared/src/index.ts",
      ),
    },
  },
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "tests/e2e/**",
      "tests/integration/**",
      "homegohan-app/**",
      ".claude/**",
      ".worktrees/**",
      "apps/mobile/**",
    ],
    environment: "jsdom",
  },
});
