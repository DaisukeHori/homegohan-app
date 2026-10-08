// @vitest-environment node
/**
 * #1199 React 19 専用 API の import を src/ で止める ESLint ルール (eslint.config.mjs) の回帰テスト
 *
 * Web アプリは Next 14 + React 18。`use` / `useActionState` / `useOptimistic` (react) と
 * `useFormStatus` (react-dom) は React 19 専用で、Next 14 のページでは動かない
 * (#1275: `use(params)` が本番で 500 になった)。型は @types/react 18 系で防いでいるが、
 * 型が 19 系に戻っても止まるよう、リポジトリの実際の ESLint 設定で import を検査する。
 *
 * 設定に直接コードを流して、
 *   - src/ 配下ではエラーになる
 *   - 通常の React 18 の API (useState など) や react-dom の createPortal は通る
 *   - src/ の外 (モバイルの apps/mobile は React 19) には効かない
 * ことを確かめる。
 */
import path from 'node:path';
import eslintPackage from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

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
}, 120_000);

/** このガードのルールが出したメッセージだけを返す (他のルールの指摘は見ない) */
async function restrictedImportMessages(relativePath: string, code: string): Promise<string[]> {
  const messages = await lintMessages(relativePath, code);
  return messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

const WEB_FILE = 'src/app/__eslint_guard_fixture__/page.tsx';

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
    expect(messages[0]).toContain('React 19 専用');
  });

  it('別名を付けても止まる (import { use as readPromise } from "react")', async () => {
    const messages = await restrictedImportMessages(
      WEB_FILE,
      `import { use as readPromise } from 'react';\nexport default function Page() { return null; }\n`,
    );
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

  it('default import だけの React も通る (import React from "react")', async () => {
    const messages = await restrictedImportMessages(
      WEB_FILE,
      `import React from 'react';\nexport const Page = React.memo(() => null);\n`,
    );
    expect(messages).toEqual([]);
  });
});

describe('#1199 src/ の外には効かない', () => {
  it('apps/mobile (Expo 53 + React 19) では use を import できる', async () => {
    const messages = await restrictedImportMessages(
      'apps/mobile/app/__eslint_guard_fixture__.tsx',
      `import { use } from 'react';\nexport default function Screen() { return null; }\n`,
    );
    expect(messages).toEqual([]);
  });
});
