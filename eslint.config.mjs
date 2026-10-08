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

// src/ で React 19 / Next 15 前提の API を使わせないルール (#1199) に共通の説明。
// 禁止の理由は「動かないから」だけではない。Next 14 の App Router が同梱する React (canary) には
// use / useOptimistic / useFormStatus が実在するが、useActionState は無く、Next 14 の params は Promise ではない
// (#1275: use(params) が本番で 500 になった)。Next 15 / React 19 前提の書き方を持ち込まないために使わない。
const REACT19_ONLY_API_MESSAGE =
  "React 19 / Next 15 前提の API です。この Web アプリは Next 14 + React 18 なので、Next 15 前提の書き方を持ち込まないよう src/ では使いません (#1275: use(params) が本番で 500 になりました)。";

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
    // Web アプリ (src/) は Next 14 + React 18。React 19 / Next 15 前提の API を使わせない (#1199)。
    //
    // 型検査はこれらを止めない。Next 14 の型 (next/types/index.d.ts) が react/experimental と
    // react-dom/experimental (canary の型) を読み込むため、@types/react が 18 系でも
    // use / useOptimistic / useActionState / useFormStatus は `npm run typecheck` を通る (実測)。
    // 止めているのはこの ESLint ルールだけなので、冗長に見えても外さないこと
    // (#1275: use(params) が型検査を素通りして本番で 500 になった)。この前提は
    // tests/eslint-react19-guard.test.ts が固定している。
    //
    // 対象は src/** だけ。apps/mobile (Expo 53 + React 19) と、ルート直下の components/ ・ lib/ は対象外。
    // 注意: importNames を指定すると `import * as React from 'react'` も検出される。
    // src/ では名前付き import (import { useState } from 'react') を使う。
    // `import React from 'react'` のあとの React.use(...) などは、下の no-restricted-properties で止める。
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              importNames: ["use", "useActionState", "useOptimistic"],
              message: `${REACT19_ONLY_API_MESSAGE}名前空間 import (import * as React) も検出されるため、名前付き import にしてください。詳細は CLAUDE.md を参照 (#1199)。`,
            },
            {
              name: "react-dom",
              importNames: ["useFormStatus"],
              message: `${REACT19_ONLY_API_MESSAGE}名前空間 import (import * as ReactDOM) も検出されるため、名前付き import にしてください。詳細は CLAUDE.md を参照 (#1199)。`,
            },
          ],
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "React",
          property: "use",
          message: `${REACT19_ONLY_API_MESSAGE}詳細は CLAUDE.md を参照 (#1199)。`,
        },
        {
          object: "React",
          property: "useActionState",
          message: `${REACT19_ONLY_API_MESSAGE}詳細は CLAUDE.md を参照 (#1199)。`,
        },
        {
          object: "React",
          property: "useOptimistic",
          message: `${REACT19_ONLY_API_MESSAGE}詳細は CLAUDE.md を参照 (#1199)。`,
        },
        {
          object: "ReactDOM",
          property: "useFormStatus",
          message: `${REACT19_ONLY_API_MESSAGE}詳細は CLAUDE.md を参照 (#1199)。`,
        },
      ],
    },
  },
];

export default config;
