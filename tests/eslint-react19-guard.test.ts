// @vitest-environment node
/**
 * #1199 React 19 / Next 15 前提の API を src/ で止める ESLint ルール (eslint.config.mjs) の回帰テスト
 *
 * Web アプリは Next 14 + React 18。`use` / `useActionState` / `useOptimistic` (react) と
 * `useFormStatus` (react-dom) は React 19 / Next 15 前提の API で、Next 14 のページには持ち込まない
 * (#1275: `use(params)` が本番で 500 になった)。
 *
 * 型検査はこれらを止めない。Next 14 の型 (next/types/index.d.ts) が react/experimental と
 * react-dom/experimental (canary の型) を読み込むため、@types/react が 18 系でも `npm run typecheck` を通る。
 * 止めているのは eslint.config.mjs の ESLint ルールだけなので、このルールを外さないこと。
 *
 * このテストは次のことを確かめる。
 *   - 前提: 型検査では止まらない (Next の型が canary の型を読み込んでいる)
 *   - src/ 配下では、import も `import React from 'react'` のあとの `React.use(...)` などもエラーになる
 *   - 通常の React 18 の API (useState など) や react-dom の createPortal は通る
 *   - src/ の外 (モバイルの apps/mobile は React 19) には効かない
 *
 * Web を React 19 / Next 15 に上げるときは、このテストと ESLint ルール、CLAUDE.md の記述を一緒に見直す。
 */
import fs from 'node:fs';
import path from 'node:path';
import eslintPackage from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** src/ 配下のファイルとして検査させるための、実在しないパス */
const WEB_FILE = 'src/app/__eslint_guard_fixture__/page.tsx';

interface LintMessage {
  ruleId: string | null;
  message: string;
}

let lintMessages: (relativePath: string, code: string) => Promise<LintMessage[]>;

beforeAll(async () => {
  // eslint.config.mjs (フラットコンフィグ) をそのまま読む。next/core-web-vitals の読み込みに数秒かかる。
  const ESLintClass = await eslintPackage.loadESLint({ useFlatConfig: true });
  const eslint = new ESLintClass({ cwd: ROOT });
  lintMessages = async (relativePath, code) => {
    const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, relativePath) });
    return result.messages as LintMessage[];
  };
  // 設定とパーサーの読み込みは最初の lintText で起きる (手元で約 1.6 秒)。最初の it (既定のタイムアウトは 5 秒) の
  // 中で起きると、CI で全テストを並列に走らせたときに揺れるので、タイムアウトの長いここで 1 回空打ちして済ませておく。
  await lintMessages(WEB_FILE, 'export {};\n');
}, 120_000);

/** 指定したルールが出したメッセージだけを返す (他のルールの指摘は見ない) */
async function messagesOf(ruleId: string, relativePath: string, code: string): Promise<string[]> {
  const messages = await lintMessages(relativePath, code);
  return messages.filter((m) => m.ruleId === ruleId).map((m) => m.message);
}

const restrictedImportMessages = (relativePath: string, code: string) =>
  messagesOf('no-restricted-imports', relativePath, code);
const restrictedPropertyMessages = (relativePath: string, code: string) =>
  messagesOf('no-restricted-properties', relativePath, code);

/** インストール済みパッケージ (ルートの node_modules) のファイルを読む */
function readInstalled(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, 'node_modules', relativePath), 'utf8');
}

describe('#1199 前提: 型検査は React 19 専用 API を止めない (だからこの ESLint ルールが唯一のガード)', () => {
  // 落ちたら: Next や @types/react の更新で、型検査が use などを止めるようになった (または型の読み込み方が変わった)
  // 可能性がある。use / useFormStatus などを import したファイルを src/ に置いて `npm run typecheck` が
  // 落ちるかを実際に確かめ、eslint.config.mjs のコメントと CLAUDE.md の記述を実態に合わせる。
  it('`from "next"` を import するだけで next/types/index.d.ts が読み込まれる (next/index.d.ts が ./types を再公開)', () => {
    expect(readInstalled('next/index.d.ts')).toMatch(/export \* from ['"]\.\/types['"]/);
  });

  it('next/types/index.d.ts が react/experimental と react-dom/experimental (canary の型) を読み込む', () => {
    const nextTypes = readInstalled('next/types/index.d.ts');
    expect(nextTypes).toMatch(/<reference types=["']react\/experimental["']\s*\/>/);
    expect(nextTypes).toMatch(/<reference types=["']react-dom\/experimental["']\s*\/>/);
  });

  it('@types/react: experimental が canary を読み込み、canary が use / useOptimistic / useActionState を宣言する', () => {
    expect(readInstalled('@types/react/experimental.d.ts')).toMatch(/require\(["']\.\/canary["']\)/);
    const canary = readInstalled('@types/react/canary.d.ts');
    expect(canary).toMatch(/function use</);
    expect(canary).toMatch(/function useOptimistic</);
    expect(canary).toMatch(/function useActionState</);
  });

  it('@types/react-dom: experimental が canary を読み込み、canary が useFormStatus を宣言する', () => {
    expect(readInstalled('@types/react-dom/experimental.d.ts')).toMatch(/require\(["']\.\/canary["']\)/);
    expect(readInstalled('@types/react-dom/canary.d.ts')).toMatch(/function useFormStatus\(/);
  });
});

describe('#1199 src/ で React 19 専用 API の import を止める', () => {
  it.each([
    ["import { use } from 'react';", 'use', 'react'],
    ["import { useActionState } from 'react';", 'useActionState', 'react'],
    ["import { useOptimistic } from 'react';", 'useOptimistic', 'react'],
    ["import { useFormStatus } from 'react-dom';", 'useFormStatus', 'react-dom'],
  ])('%s はエラーになる', async (code, name, source) => {
    const messages = await restrictedImportMessages(WEB_FILE, `${code}\nexport default function Page() { return null; }\n`);
    expect(messages).toHaveLength(1);
    // ESLint 標準の文言 ("'use' import from 'react' is restricted.") に、このルールの説明が続く
    expect(messages[0]).toContain(`'${name}' import from '${source}' is restricted`);
    expect(messages[0]).toContain('React 19 / Next 15 前提');
  });

  it('別名を付けても止まる (import { use as readPromise } from "react")', async () => {
    const messages = await restrictedImportMessages(
      WEB_FILE,
      `import { use as readPromise } from 'react';\nexport default function Page() { return null; }\n`,
    );
    expect(messages).toHaveLength(1);
  });

  it('再公開 (export { use } from "react") も止まる', async () => {
    const messages = await restrictedImportMessages(WEB_FILE, `export { use } from 'react';\n`);
    expect(messages).toHaveLength(1);
  });

  it('1 つの import 文に複数あれば、それぞれ指摘する', async () => {
    const messages = await restrictedImportMessages(
      WEB_FILE,
      `import { useState, use, useOptimistic } from 'react';\nexport default function Page() { return null; }\n`,
    );
    expect(messages).toHaveLength(2);
  });

  it('名前空間 import (import * as React) も検出される (名前付き import を使う運用)', async () => {
    const messages = await restrictedImportMessages(
      WEB_FILE,
      `import * as React from 'react';\nexport const Page = React.memo(() => null);\n`,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('名前付き import');
  });

  it('React 18 で使える API は通る (useState / useEffect / forwardRef / createPortal)', async () => {
    const messages = await restrictedImportMessages(
      WEB_FILE,
      [
        "import { forwardRef, useEffect, useState } from 'react';",
        "import { createPortal } from 'react-dom';",
        'export default function Page() { return null; }',
        '',
      ].join('\n'),
    );
    expect(messages).toEqual([]);
  });

  it('default import だけの React も import としては通る (import React from "react")', async () => {
    const messages = await restrictedImportMessages(
      WEB_FILE,
      `import React from 'react';\nexport const Page = React.memo(() => null);\n`,
    );
    expect(messages).toEqual([]);
  });
});

describe('#1199 src/ で `import React from "react"` のあとの React.use(...) なども止める', () => {
  // import の検査だけだと、default import した React の経由 (src/ の約 60 ファイルが使う書き方) はすり抜ける。
  // 型検査も止めないので (上の「前提」を参照)、no-restricted-properties で止める。
  it.each([
    [
      'React.use(promise)',
      "import React from 'react';\nexport const read = (p: Promise<number>) => React.use(p);\n",
      'React.use',
    ],
    [
      'React.useOptimistic(…)',
      "import React from 'react';\nexport const hook = () => React.useOptimistic(0);\n",
      'React.useOptimistic',
    ],
    [
      'React.useActionState(…)',
      "import React from 'react';\nexport const hook = () => React.useActionState(async (s: number) => s, 0);\n",
      'React.useActionState',
    ],
    [
      'ReactDOM.useFormStatus()',
      "import ReactDOM from 'react-dom';\nexport const hook = () => ReactDOM.useFormStatus();\n",
      'ReactDOM.useFormStatus',
    ],
    [
      "React['use'](promise) (文字列のキー)",
      "import React from 'react';\nexport const read = (p: Promise<number>) => React['use'](p);\n",
      'React.use',
    ],
    [
      'const { use } = React (分割代入)',
      "import React from 'react';\nconst { use } = React;\nexport const read = use;\n",
      'React.use',
    ],
  ])('%s はエラーになる', async (_name, code, restricted) => {
    const messages = await restrictedPropertyMessages(WEB_FILE, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`'${restricted}' is restricted`);
    expect(messages[0]).toContain('React 19 / Next 15 前提');
  });

  it('import * as React のあとの React.use(...) は import と呼び出しの両方を指摘する', async () => {
    const code = `import * as React from 'react';\nexport const read = (p: Promise<number>) => React.use(p);\n`;
    expect(await restrictedImportMessages(WEB_FILE, code)).toHaveLength(1);
    expect(await restrictedPropertyMessages(WEB_FILE, code)).toHaveLength(1);
  });

  it('React 18 で使える React.memo / React.useState / ReactDOM.createPortal は通る', async () => {
    const messages = await restrictedPropertyMessages(
      WEB_FILE,
      [
        "import React from 'react';",
        "import ReactDOM from 'react-dom';",
        'export const Page = React.memo(() => null);',
        'export const useCount = () => React.useState(0);',
        'export const portal = ReactDOM.createPortal;',
        '',
      ].join('\n'),
    );
    expect(messages).toEqual([]);
  });
});

describe('#1199 src/ の外には効かない', () => {
  // 対象の `src/**` はリポジトリ直下の src/ (Web アプリ) だけ。モバイルにも apps/mobile/src/ があるが React 19 なので対象外。
  const MOBILE_FILES = [
    'apps/mobile/app/__eslint_guard_fixture__.tsx',
    'apps/mobile/src/__eslint_guard_fixture__.tsx',
  ];

  it.each(MOBILE_FILES)('%s (Expo 53 + React 19) では use を import できる', async (file) => {
    const messages = await restrictedImportMessages(
      file,
      `import { use } from 'react';\nexport default function Screen() { return null; }\n`,
    );
    expect(messages).toEqual([]);
  });

  it.each(MOBILE_FILES)('%s では React.use(...) も使える', async (file) => {
    const messages = await restrictedPropertyMessages(
      file,
      `import React from 'react';\nexport const read = (p: Promise<number>) => React.use(p);\n`,
    );
    expect(messages).toEqual([]);
  });
});
