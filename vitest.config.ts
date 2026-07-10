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
  // tsconfig.json は Next.js の SWC コンパイラ向けに jsx: "preserve" を指定しているが、
  // このバージョンの Vite (rolldown-vite, oxc ベース) は tsconfig の jsx: "preserve" を
  // そのまま引き継いでしまい .tsx の変換に失敗する
  // ("Failed to parse source... jsx to preserve" エラー)。
  // tsconfig.json 自体は Next.js ビルド/tsc の都合で変更せず、Vitest 専用の
  // oxc 設定だけを上書きしてコンポーネントの render テストを可能にする (#1031)。
  oxc: {
    jsx: { runtime: "automatic" },
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
