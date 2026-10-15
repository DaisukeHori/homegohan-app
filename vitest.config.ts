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

// test.each / test.for の題名に差し込む値を切り詰めない (0 = 切り詰めない)。
// vitest 5 から既定が 40 文字になり、「止める経路: analyze-meal-photo (食事の写真 → Edge Func…」のように
// 行を見分ける部分が「…」で消える題名が出た (#1621。vitest 4 までは切り詰めていなかった)。
// 失敗したときに題名からどの行かを読めるように、vitest 4 と同じく値をそのまま出す。
export const TASK_TITLE_VALUE_NO_TRUNCATE = 0;

export default defineConfig({
  plugins: [atAliasPlugin()],
  resolve: {
    alias: {
      "@homegohan/handson-tour-shared": path.resolve(
        __dirname,
        "packages/handson-tour-shared/src/index.ts",
      ),
      // tsconfig.json の paths と同じく、このリポジトリの packages/shared を直接読む。
      // node_modules/@homegohan/shared (ワークスペースのシンボリックリンク) 経由だと、
      // node_modules を別の場所のものと共有している作業コピー (git worktree など) で
      // 手元の packages/shared ではなくリンク先の古い内容を読んでしまい、
      // 追加した定数が見えずにテストが空振りするため (#1197)。
      "@homegohan/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
      // @homegohan/core も同じ理由で、このリポジトリの packages/core を直接読む (#1146)。
      // 作業コピーで node_modules を共有していると、リンク先の古い packages/core を読んでしまい、
      // 手元で変えた SUGAR_APP_DEFAULT などがテストに反映されなかった。
      // packages/core/package.json の exports は "." (src/index.ts) だけで、サブパスの import は無い。
      "@homegohan/core": path.resolve(__dirname, "packages/core/src/index.ts"),
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
    taskTitleValueFormatTruncate: TASK_TITLE_VALUE_NO_TRUNCATE,
  },
});
