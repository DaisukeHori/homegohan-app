// @vitest-environment node
/**
 * #1621 React 19 で非推奨になった import を Web に戻さない ESLint ルール (eslint.config.mjs) の回帰テスト
 *
 * Web アプリは React 19 (#1444)。次の 2 つは React 19 で非推奨になった。
 *   - react-dom/test-utils: act 以外が消え、残った act も非推奨 (呼ぶたびに警告が出る)。act は react から import する
 *     (#1608 の 2 本のテストが react-dom/test-utils の act を使ったまま入り、#1621 で直した)
 *   - react-test-renderer (react-test-renderer/shallow などの下のパスを含む): 非推奨。描画は react-dom/client の createRoot と react の act で書く
 *
 * 型検査はこれを止めない: @types/react-dom 19 の react-dom/test-utils は act を @deprecated の印つきで再公開しているだけで、
 * import しても `npm run typecheck` は通る (下の「前提」で確かめる)。止めているのは eslint.config.mjs の ESLint ルール
 * (`npm run lint`・CI の unit の段) なので、このルールを外さないこと。
 *
 * このテストは、実際の eslint.config.mjs を読んだ ESLint で次のことを確かめる。
 *   - Web の置き場 (src/・tests/・lib/) では、名前付き / 名前空間 / 型の import・再公開・動的 import・require のどれもエラーになる
 *   - react の act・react-dom/client の createRoot・react-dom の createPortal、コメントや文字列の中の名前は通る
 *   - モバイル (apps/mobile。react-native の版に合わせた jest + react-test-renderer を持つ。#1591) には効かない
 */
import fs from 'node:fs';
import path from 'node:path';
import eslintPackage from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

import { resolveHeavyUnitTimeouts } from './helpers/heavy-unit-test-timeout';

const ROOT = path.resolve(__dirname, '..');

/** このルールが出すメッセージのルール ID (import 文は no-restricted-imports、動的 import と require は no-restricted-syntax) */
const GUARD_RULE_IDS: readonly string[] = ['no-restricted-imports', 'no-restricted-syntax'];

/** Web の置き場のファイルとして検査させるための、実在しないパス */
const WEB_FILES = [
  'src/__tests__/__react19_guard_fixture__.test.tsx',
  'tests/__react19_guard_fixture__.test.ts',
  'lib/__react19_guard_fixture__.ts',
];
/** モバイルの置き場のファイルとして検査させるための、実在しないパス */
const MOBILE_FILES = [
  'apps/mobile/__tests__/__react19_guard_fixture__.test.tsx',
  'apps/mobile/src/__react19_guard_fixture__.tsx',
];

type Fixture = { name: string; code: string };

/** Web では 1 件ずつエラーになる書き方 */
const FORBIDDEN: readonly Fixture[] = [
  {
    name: "import { act } from 'react-dom/test-utils'",
    code: "import { act } from 'react-dom/test-utils';\nexport const run = act;\n",
  },
  {
    name: "import * as TestUtils from 'react-dom/test-utils'",
    code: "import * as TestUtils from 'react-dom/test-utils';\nexport const run = TestUtils.act;\n",
  },
  { name: "export { act } from 'react-dom/test-utils'", code: "export { act } from 'react-dom/test-utils';\n" },
  {
    name: "import TestRenderer from 'react-test-renderer'",
    code: "import TestRenderer from 'react-test-renderer';\nexport const renderer = TestRenderer;\n",
  },
  {
    name: "import ShallowRenderer from 'react-test-renderer/shallow'",
    code: "import ShallowRenderer from 'react-test-renderer/shallow';\nexport const renderer = ShallowRenderer;\n",
  },
  {
    name: "import type { ReactTestRenderer } from 'react-test-renderer'",
    code: "import type { ReactTestRenderer } from 'react-test-renderer';\nexport type Renderer = ReactTestRenderer;\n",
  },
  { name: "import('react-dom/test-utils')", code: "export const load = () => import('react-dom/test-utils');\n" },
  { name: "import('react-test-renderer/shallow')", code: "export const load = () => import('react-test-renderer/shallow');\n" },
  { name: "require('react-test-renderer')", code: "export const load = () => require('react-test-renderer');\n" },
  { name: "require('react-dom/test-utils')", code: "export const load = () => require('react-dom/test-utils');\n" },
];

/** Web でも通る書き方 (このルールの指摘が 0 件) */
const ALLOWED: readonly Fixture[] = [
  { name: "import { act } from 'react'", code: "import { act } from 'react';\nexport const run = act;\n" },
  { name: "import React, { act } from 'react'", code: "import React, { act } from 'react';\nexport const run = [React, act];\n" },
  {
    name: "import { createRoot } from 'react-dom/client'",
    code: "import { createRoot } from 'react-dom/client';\nexport const make = createRoot;\n",
  },
  { name: "import { createPortal } from 'react-dom'", code: "import { createPortal } from 'react-dom';\nexport const portal = createPortal;\n" },
  { name: "import('react-dom/client')", code: "export const load = () => import('react-dom/client');\n" },
  {
    name: '名前が前方一致するだけの別のパッケージ (react-test-renderer-extra)',
    code: "import extra from 'react-test-renderer-extra';\nexport const loaded = extra;\n",
  },
  {
    name: 'コメントの中の名前',
    code: "// react-dom/test-utils の act は使わない。react-test-renderer も使わない\nexport {};\n",
  },
  { name: '文字列の中の名前 (import でない)', code: "export const NAME = 'react-dom/test-utils';\nexport const OTHER = 'react-test-renderer';\n" },
];

interface LintMessage {
  ruleId: string | null;
  message: string;
}

/** ファイル × 書き方ごとの、このルールの指摘 (beforeAll で一度に作る) */
const guardMessages = new Map<string, string[]>();
const keyOf = (file: string, fixture: Fixture) => `${file} :: ${fixture.name}`;

/** インストール済みパッケージ (ルートの node_modules) のファイルを読む */
function readInstalled(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, 'node_modules', relativePath), 'utf8');
}

// eslint.config.mjs (next/core-web-vitals を含む) の読み込みと、すべての書き方の lint はここで済ませる (手元で数秒)。
// 負荷の高い機械では既定のフックの時間切れ (10 秒) を超えうるので、#1488 の時間切れ (フック 60 秒・環境変数で上書き可) を渡す。
// テストの中は結果を見るだけなので、テストの時間切れは既定のまま。
beforeAll(async () => {
  const ESLintClass = await eslintPackage.loadESLint({ useFlatConfig: true });
  const eslint = new ESLintClass({ cwd: ROOT });
  const files = [...WEB_FILES, ...MOBILE_FILES];
  for (const file of files) {
    for (const fixture of [...FORBIDDEN, ...ALLOWED]) {
      const [result] = await eslint.lintText(fixture.code, { filePath: path.join(ROOT, file) });
      const messages = result.messages as LintMessage[];
      guardMessages.set(
        keyOf(file, fixture),
        messages.filter((m) => m.ruleId !== null && GUARD_RULE_IDS.includes(m.ruleId)).map((m) => m.message),
      );
    }
  }
}, resolveHeavyUnitTimeouts(process.env).hookTimeout);

function messagesFor(file: string, fixture: Fixture): string[] {
  const messages = guardMessages.get(keyOf(file, fixture));
  if (!messages) throw new Error(`lint の結果が無い: ${keyOf(file, fixture)}`);
  return messages;
}

describe('#1621 前提: 型検査は react-dom/test-utils の act を止めない (だからこの ESLint ルールが見張り)', () => {
  // 落ちたら: @types/react-dom の更新で react-dom/test-utils の形が変わった。型検査で止まるようになったなら、
  // このテストと eslint.config.mjs のコメントを実態に合わせる。
  it('@types/react-dom の react-dom/test-utils は act を @deprecated の印つきで react から再公開している', () => {
    const testUtils = readInstalled('@types/react-dom/test-utils/index.d.ts');
    expect(testUtils).toMatch(/@deprecated Import `act` from `react` instead\./);
    expect(testUtils).toMatch(/\bact,\s*\}\s*from\s*["']react["']/);
  });
});

describe('#1621 Web の置き場では React 19 で非推奨の import がエラーになる', () => {
  for (const file of WEB_FILES) {
    it.each(FORBIDDEN.map((fixture) => [fixture.name, fixture] as const))(`${file}: %s はエラーになる`, (_name, fixture) => {
      const messages = messagesFor(file, fixture);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('React 19 で非推奨');
    });
  }

  it('import 文の指摘は、ESLint の標準の文言 (どのモジュールか) に、このルールの説明が続く', () => {
    const [testUtils] = messagesFor(WEB_FILES[0], FORBIDDEN[0]);
    expect(testUtils).toContain("'react-dom/test-utils' import is restricted");
    expect(testUtils).toContain("act は react から import してください");
    const [renderer] = messagesFor(WEB_FILES[0], FORBIDDEN[3]);
    expect(renderer).toContain("'react-test-renderer' import is restricted");
    expect(renderer).toContain('react-dom/client の createRoot');
  });

  it.each(ALLOWED.map((fixture) => [fixture.name, fixture] as const))('%s は通る', (_name, fixture) => {
    for (const file of WEB_FILES) expect(messagesFor(file, fixture), file).toEqual([]);
  });
});

describe('#1621 モバイル (apps/mobile) には効かない', () => {
  it.each(MOBILE_FILES)('%s では、どの書き方もこのルールの指摘にならない', (file) => {
    for (const fixture of FORBIDDEN) expect(messagesFor(file, fixture), fixture.name).toEqual([]);
  });
});
