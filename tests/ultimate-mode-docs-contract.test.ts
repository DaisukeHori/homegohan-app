// @vitest-environment node
/**
 * #1142 究極モードの開放を書いた文 (docs の追記・e2e の spec の説明) の contract テスト (ソース走査)
 *
 * 究極モードは全員に開放したうえで、1 日の AI の上限とは別に、利用者ごと・1 日 (JST の暦日) に 1 回までにしている。
 * 「開放した」とだけ書いて上限を書き落とした文や、出どころが確かめられない帰属 (日付つきの「判断」) が戻らないよう、次を確かめる。
 *
 *   1. 開放を書いた文は、1 日 1 回の上限と、その定数・環境変数の名前を書く (名前は実装の export と一致する)
 *   2. 「オーナー判断」の帰属と、出どころの確かめられない 2026-10-08 の日付を書かない
 *
 * 振る舞いそのものの確認は tests/integration/rls/ai-usage-feature-cap-rpc.test.ts と src/__tests__/lib/plan/entitlements.test.ts にある。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT,
  AI_ULTIMATE_MODE_DAILY_LIMIT_ENV,
} from '../supabase/functions/_shared/ai-usage-core';

const ROOT = path.resolve(__dirname, '..');

/** 究極モードの開放を追記した docs (経緯の報告書。2 か所に同じ追記がある) */
const OPENING_ADDENDUM_DOCS = [
  'docs/bug-fix-report-2026-04.md',
  'docs/handover/bug-fix-report-2026-04.md',
] as const;

/** 究極モードの開放を確かめる e2e の spec (ファイル名は経緯が追えるよう据え置き) */
const OPENING_E2E_SPEC = 'tests/e2e/bug-27-ultimate-mode-locked.spec.ts';

const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

/** docs のうち #1142 の追記の段落 (引用ブロックの 1 行) だけを取り出す */
function openingAddendum(relativePath: string): string {
  const lines = read(relativePath)
    .split('\n')
    .filter((line) => line.startsWith('>') && line.includes('#1142'));
  expect(lines, `${relativePath} に #1142 の追記が 1 つだけある`).toHaveLength(1);
  return lines[0];
}

/** spec の先頭の説明のコメント (最初の import より前) */
function e2eHeader(): string {
  const source = read(OPENING_E2E_SPEC);
  const end = source.indexOf('import ');
  expect(end).toBeGreaterThan(0);
  return source.slice(0, end);
}

const UNVERIFIED_ATTRIBUTION = 'オーナー判断';
const UNVERIFIED_DATE = '2026-10-08';

describe('究極モードの開放を書いた文は、1 日 1 回の上限も書く (#1142)', () => {
  it('上限の定数は 1 回 (文の「1 回」と実装が合っている)', () => {
    expect(AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT).toBe(1);
  });

  it.each(OPENING_ADDENDUM_DOCS)('%s の追記は、上限・定数・環境変数・429 を書く', (doc) => {
    const addendum = openingAddendum(doc);
    expect(addendum).toContain('全員へ開放した');
    expect(addendum).toContain('1 日 (JST の暦日) に 1 回まで');
    expect(addendum).toContain('`AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT` = 1');
    expect(addendum).toContain(`\`${AI_ULTIMATE_MODE_DAILY_LIMIT_ENV}\``);
    expect(addendum).toContain('429 `AI_DAILY_LIMIT`');
  });

  it('2 か所の追記は同じ文 (片方だけ直した食い違いを作らない)', () => {
    const [first, second] = OPENING_ADDENDUM_DOCS.map(openingAddendum);
    expect(second).toBe(first);
  });

  it('e2e の spec の説明は、上限と、上限を確かめるテストの場所を書く', () => {
    const header = e2eHeader();
    expect(header).toContain('1 日 (JST の暦日) に 1 回まで');
    expect(header).toContain('tests/integration/rls/ai-usage-feature-cap-rpc.test.ts');
    expect(fs.existsSync(path.join(ROOT, 'tests/integration/rls/ai-usage-feature-cap-rpc.test.ts'))).toBe(true);
  });
});

describe('究極モードの開放を書いた文に、出どころが確かめられない帰属を書かない (#1142)', () => {
  it.each(OPENING_ADDENDUM_DOCS)('%s の追記', (doc) => {
    const addendum = openingAddendum(doc);
    expect(addendum).not.toContain(UNVERIFIED_ATTRIBUTION);
    expect(addendum).not.toContain(UNVERIFIED_DATE);
  });

  it('e2e の spec の説明', () => {
    const header = e2eHeader();
    expect(header).not.toContain(UNVERIFIED_ATTRIBUTION);
    expect(header).not.toContain(UNVERIFIED_DATE);
  });
});
