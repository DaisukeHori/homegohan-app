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

/** #1621 React 19 で非推奨の import の説明 (no-restricted-imports の文言に続けて出る) */
const REACT_DOM_TEST_UTILS_MESSAGE =
  "React 19 で非推奨です。act は react から import してください (import { act } from 'react')。";
const REACT_TEST_RENDERER_MESSAGE =
  "React 19 で非推奨です。react-dom/client の createRoot と react の act で描画してください。";
const REACT19_DEPRECATED_DYNAMIC_MESSAGE =
  "react-dom/test-utils と react-test-renderer は React 19 で非推奨です (act は react から、描画は react-dom/client の createRoot で)。";
/**
 * 動的 import / require で止めるモジュール名 (esquery の正規表現。react-test-renderer の下のパスも含む)。
 * esquery の正規表現は「/」を中に書けない (エスケープしても区切りと読む) ので、「/」は \x2F で書く
 */
const REACT19_DEPRECATED_MODULE_SELECTOR = "/^(?:react-dom\\x2Ftest-utils|react-test-renderer(?:\\x2F.*)?)$/";

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
    // #1621: Web (React 19) で非推奨になった import を戻さない (tests/react19-deprecated-imports-guard.test.ts が検査する)。
    //   - react-dom/test-utils: React 19 で act 以外が消え、残った act も非推奨 (呼ぶたびに警告が出る)。act は react から import する
    //   - react-test-renderer (と react-test-renderer/shallow など): React 19 で非推奨。描画は react-dom/client の createRoot と react の act で書く
    // モバイル (apps/mobile) は対象外: react-native の版に合わせた別のツールチェーン (jest + react-test-renderer) を持つ (#1591)。
    // 名前付きの import・再公開に加えて、動的 import (import('…')) と require('…') も止める。
    ignores: ["apps/mobile/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react-dom/test-utils", message: REACT_DOM_TEST_UTILS_MESSAGE },
            { name: "react-test-renderer", message: REACT_TEST_RENDERER_MESSAGE },
          ],
          patterns: [{ group: ["react-test-renderer/*"], message: REACT_TEST_RENDERER_MESSAGE }],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: `ImportExpression > Literal.source[value=${REACT19_DEPRECATED_MODULE_SELECTOR}]`,
          message: REACT19_DEPRECATED_DYNAMIC_MESSAGE,
        },
        {
          selector: `CallExpression[callee.type='Identifier'][callee.name='require'] > Literal.arguments[value=${REACT19_DEPRECATED_MODULE_SELECTOR}]`,
          message: REACT19_DEPRECATED_DYNAMIC_MESSAGE,
        },
      ],
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
