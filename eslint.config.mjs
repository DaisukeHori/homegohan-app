import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import tsPlugin from "@typescript-eslint/eslint-plugin";

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

/**
 * #1621 eslint-config-next 16 が入れる eslint-plugin-react-hooks 7 の recommended のうち、React Compiler 向けのルール。
 * Next 15 (eslint-plugin-react-hooks 5) の recommended は rules-of-hooks と exhaustive-deps の 2 つだけだった。
 * このアプリは React Compiler を使っていない (next.config.mjs の reactCompiler は無効) ので、Next 16 への更新ではこれらを
 * 有効にせず、lint の検査の範囲を Next 15 のときと同じに保つ (有効にすると既存のコードで 236 件のエラーになる (2026-10-16 の実測)。
 * 直すと描画の動きが変わりうるので、React Compiler を入れるときに別の Issue で扱う)。
 * rules-of-hooks と exhaustive-deps は今までどおり効かせる (tests/eslint-next16-config.test.ts が検査する)。
 */
export const REACT_COMPILER_RULES_OFF = [
  "react-hooks/static-components",
  "react-hooks/use-memo",
  "react-hooks/preserve-manual-memoization",
  "react-hooks/incompatible-library",
  "react-hooks/immutability",
  "react-hooks/globals",
  "react-hooks/refs",
  "react-hooks/set-state-in-effect",
  "react-hooks/error-boundaries",
  "react-hooks/purity",
  "react-hooks/set-state-in-render",
  "react-hooks/unsupported-syntax",
  "react-hooks/config",
  "react-hooks/gating",
];

const config = [
  // #1621 Next 16: eslint-config-next 16 は flat config を直接出す (ESLint 9 が要る)。Next 15 までの FlatCompat 経由の
  // 読み込み (compat.extends("next/core-web-vitals")) は使わない。
  ...nextCoreWebVitals,
  {
    // #1621 ESLint 9 は、使われていない eslint-disable のコメントを既定で警告する (ESLint 8 は報告しなかった)。
    // lint の検査の範囲を ESLint 8 のときと同じに保つため、報告しない (既存のコメントの掃除は別に行う)。
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    rules: Object.fromEntries(REACT_COMPILER_RULES_OFF.map((rule) => [rule, "off"])),
  },
  {
    // next/core-web-vitals は @typescript-eslint プラグインを .ts / .tsx にしか登録しない (16。15 はどのファイルにも登録しなかった) ため、
    // .js / .mjs などの `// eslint-disable-next-line @typescript-eslint/no-xxx` 等のインライン
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
    // フックではない。eslint-plugin-react-hooks (eslint-config-next 15 の 5 も、16 の 7 も) は、React 19 の `use` を
    // フックとして数えるので、fixture の関数 (名前が use で始まらない) で rules-of-hooks を誤検出する (#1444・#1621)。
    // e2e には React のコンポーネントもフックも無いので、このルールだけを外す。
    files: ["tests/e2e/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
];

export default config;
