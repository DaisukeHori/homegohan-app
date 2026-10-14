import path from "path";
import { fileURLToPath } from "url";

import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});

const config = [
  ...compat.extends("next/core-web-vitals"),
  {
    // next/core-web-vitals は @typescript-eslint プラグインを登録しないため、
    // `// eslint-disable-next-line @typescript-eslint/no-xxx` 等のインライン
    // ディレクティブコメントが "Definition for rule not found" エラーになる。
    // ルール自体は有効化せず、プラグインを登録してルールIDを解決可能にするだけ。
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
  },
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "homegohan-app/**",
      ".worktrees/**",
    ],
  },
  {
    files: ["apps/mobile/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/exhaustive-deps": "off",
      "jsx-a11y/alt-text": "off",
    },
  },
  {
    // Playwright の fixture (test.extend) は、準備ができたら `await use(値)` を呼ぶ決まり。この `use` は React の
    // フックではない。eslint-config-next 15 に入っている eslint-plugin-react-hooks 5 は、React 19 の `use` を
    // フックとして数えるので、fixture の関数 (名前が use で始まらない) で rules-of-hooks を誤検出する (#1444)。
    // e2e には React のコンポーネントもフックも無いので、このルールだけを外す。
    files: ["tests/e2e/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
];

export default config;
