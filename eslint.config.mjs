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
    // Web アプリ (src/) は Next 14 + React 18。React 19 専用の API を import させない (#1199)。
    // @types/react を 18 系にそろえたので `use` などは型検査でも落ちるが、型が 19 系に戻っても
    // 実行時に壊れる import を通さないよう lint でも止める (#1275: use(params) が本番で 500 になった再発防止)。
    // apps/mobile (Expo 53 + React 19) は対象外。
    // 注意: importNames を指定すると `import * as React from 'react'` も検出される。
    // src/ では名前付き import (import { useState } from 'react') を使う。
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              importNames: ["use", "useActionState", "useOptimistic"],
              message:
                "React 19 専用の API です。この Web アプリは Next 14 + React 18 なので使えません (Next 14 の params は Promise ではなく、use(params) は例外になります)。名前空間 import (import * as React) も検出されるため、名前付き import にしてください。詳細は CLAUDE.md を参照 (#1199)。",
            },
            {
              name: "react-dom",
              importNames: ["useFormStatus"],
              message:
                "React 19 専用の API です。この Web アプリは Next 14 + React 18 なので使えません。名前空間 import (import * as ReactDOM) も検出されるため、名前付き import にしてください。詳細は CLAUDE.md を参照 (#1199)。",
            },
          ],
        },
      ],
    },
  },
];

export default config;
