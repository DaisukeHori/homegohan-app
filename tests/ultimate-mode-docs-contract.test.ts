// @vitest-environment node
/**
 * #1142 究極モードの開放を書いた文 (docs の追記・e2e の spec の説明) の contract テスト (ソース走査)
 *
 * 究極モードは #1142 で全員に開放したうえで、1 日の AI の上限とは別に、利用者ごと・1 日 (JST の暦日) に 1 回までにした。
 * いまは billing/03 §6.5 で有料プランの機能になり、1 日の回数は ai_plan_feature_caps の行の値 (free 0 / pro 2 / family_basic 2 / family_pro 3)。
 * 既定の 1 回と環境変数は、行の無いプラン (組織のプランなど) にだけ効く (docs の追記もそう書く。下の 1)。
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

// ---------------------------------------------------------------
// billing/03 §6.5 (#1912) の後: 究極モードの回数はプランの行 (ai_plan_feature_caps) で決まる
// ---------------------------------------------------------------
//
// 「究極モードは全員が使え、上限は環境変数の 1 回だけで DB に値を持たない」という #1142 の時点の書き方が、
// 有料プランの販売 (#1912) の後も残っていた (10/22 の審査の指摘)。上限の既定・環境変数を書いた文は、行のあるプランでは
// 行の値で決まることと、その値 (migration の既定の行から作る) を書く。

/** 究極モードの、プランごとの既定の行を入れる migration (billing/03 §6.5 の (5')) */
const PLAN_FEATURE_CAPS_MIGRATION = 'supabase/migrations/20261021100000_billing_paid_plans_iap.sql';
const ULTIMATE_FEATURE = 'menu_generation_ultimate';

/** migration の INSERT から「free 0 / pro 2 / …」の並びを作る (行の順のまま) */
function ultimateCapsSummaryFromMigration(): string {
  const sql = read(PLAN_FEATURE_CAPS_MIGRATION);
  const rows = [...sql.matchAll(/\('([a-z_]+)',\s*'menu_generation_ultimate',\s*(\d+)\)/g)].map(
    ([, plan, cap]) => `${plan} ${cap}`,
  );
  expect(rows.length, `${PLAN_FEATURE_CAPS_MIGRATION} に ${ULTIMATE_FEATURE} の既定の行がある`).toBeGreaterThan(0);
  return rows.join(' / ');
}

/** start を含む位置から end の手前までを切り出す (どちらも 1 つだけあること) */
function sliceBetween(source: string, start: string, end: string, label: string): string {
  const from = source.indexOf(start);
  expect(from, `${label} に「${start}」がある`).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(start, from + 1), `${label} の「${start}」は 1 つだけ`).toBe(-1);
  const to = source.indexOf(end, from);
  expect(to, `${label} の「${start}」の後に「${end}」がある`).toBeGreaterThan(from);
  return source.slice(from, to);
}

/** 究極モードの上限の既定・環境変数を書いた文 (docs/design の外。設計書は design-doc の patch の側で直す) */
const ULTIMATE_CAP_TEXTS: ReadonlyArray<readonly [label: string, text: () => string]> = [
  ['CLAUDE.md の究極モードの箇条', () => sliceBetween(read('CLAUDE.md'), '- 究極モード (#1142):', '\n', 'CLAUDE.md')],
  [
    '.env.example の AI_ULTIMATE_MODE_DAILY_LIMIT の節',
    () => sliceBetween(read('.env.example'), '# ---- 献立生成の究極モードの 1 日の上限', `# ${AI_ULTIMATE_MODE_DAILY_LIMIT_ENV}=`, '.env.example'),
  ],
  [
    '_shared/ai-usage-core.ts の機能ごとの上限の注',
    () =>
      sliceBetween(
        read('supabase/functions/_shared/ai-usage-core.ts'),
        '// 機能ごとの 1 日の上限',
        'export const AI_ULTIMATE_MODE_FEATURE',
        'ai-usage-core.ts',
      ),
  ],
  ...OPENING_ADDENDUM_DOCS.map((doc) => [`${doc} の #1142 の追記`, () => openingAddendum(doc)] as const),
  [`${OPENING_E2E_SPEC} の説明`, () => e2eHeader()],
];

/** #1142 の時点の書き方で、いまは事実と違うもの */
const STALE_ULTIMATE_PHRASES = ['全員に開放されている', '全員 (free を含む) が使える', '上限の値は DB に置かず'] as const;

/** 究極モードの開放 (#1142) を書いたテストの説明 (先頭のコメント) */
const OPENING_TEST_HEADERS = [
  'apps/mobile/__tests__/menus-weekly/ultimate-mode-toggle.test.tsx',
  OPENING_E2E_SPEC,
  'supabase/functions/_shared/ai-usage-core.ts',
] as const;

describe('究極モードの上限を書いた文は、プランの行 (ai_plan_feature_caps) で決まることも書く (#1912・billing/03 §6.5)', () => {
  it('migration の既定の行は free 0 / pro 2 / family_basic 2 / family_pro 3 (下の文が写す値)', () => {
    expect(ultimateCapsSummaryFromMigration()).toBe('free 0 / pro 2 / family_basic 2 / family_pro 3');
  });

  it.each(ULTIMATE_CAP_TEXTS)('%s は ai_plan_feature_caps と、migration の行の値を書く', (_label, text) => {
    const body = text();
    expect(body).toContain('ai_plan_feature_caps');
    expect(body).toContain(ultimateCapsSummaryFromMigration());
    // 既定の 1 回・環境変数は、行の無いプランにだけ効くと書く
    expect(body).toContain('行の無いプラン');
  });

  it.each(OPENING_TEST_HEADERS)('%s に、#1142 の時点の書き方 (全員が使える・値を DB に置かない) が残っていない', (file) => {
    const source = read(file);
    for (const phrase of STALE_ULTIMATE_PHRASES) {
      expect(source, `${file} に「${phrase}」`).not.toContain(phrase);
    }
  });
});
