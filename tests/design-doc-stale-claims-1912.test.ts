// @vitest-environment node
/**
 * 設計書 (docs/design) に残った #1912 の後の記録の古さが戻らないことの contract テスト (ソース走査)
 *
 *   1. 究極モードの 1 日の上限 (operator/06 §5.1・family/09 の step2): 回数はプランの行 (ai_plan_feature_caps) で決まる。
 *      #1142 の時点の「全員 (free を含む) が使える・値は DB に持たない」を書かない。値は migration の既定の行と一致する
 *   2. cron の route の延命: #1922 (48fc47bf) で 4 本の route から 1 秒の延命 (LOG_FLUSH_GRACE_MS と waitUntil) を外した
 *      (ログの保存の完了は db-logger が待つ。#1913)。設計書の正典コード・本文・テストの一覧に延命を書かない
 *
 * route が延命しないことそのものは src/__tests__/api/cron/cron-log-keepalive-1909.test.ts が見張る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

/** 究極モードの、プランごとの既定の行を入れる migration (billing/03 §6.5 の (5')) */
const PLAN_FEATURE_CAPS_MIGRATION = 'supabase/migrations/20261021100000_billing_paid_plans_iap.sql';

/** migration の INSERT から [plan, cap] の並びを作る (行の順のまま) */
function ultimateCapRowsFromMigration(): Array<readonly [string, string]> {
  const sql = read(PLAN_FEATURE_CAPS_MIGRATION);
  const rows = [...sql.matchAll(/\('([a-z_]+)',\s*'menu_generation_ultimate',\s*(\d+)\)/g)].map(
    ([, plan, cap]) => [plan, cap] as const,
  );
  expect(rows.length, `${PLAN_FEATURE_CAPS_MIGRATION} に menu_generation_ultimate の既定の行がある`).toBeGreaterThan(0);
  return rows;
}

/** 設計書の markdown をすべて (docs/design の下を再帰で) */
function designDocs(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) out.push(rel);
    }
  };
  walk('docs/design');
  return out;
}

const OPERATOR_AI_DOC = 'docs/design/operator/06-ai-llm.md';
const ONBOARDING_STEP2_DOC = 'docs/design/family/09-onboarding-handson-tour/04-step2-menu.md';

/** operator/06 §5.1 の表の、究極モードの行 */
function ultimateCapRow(): string {
  const rows = read(OPERATOR_AI_DOC)
    .split('\n')
    .filter((line) => line.startsWith('| 機能ごとの 1 日の上限 (上限に数える機能・#1142) |'));
  expect(rows, `${OPERATOR_AI_DOC} に究極モードの上限の行が 1 つだけある`).toHaveLength(1);
  return rows[0];
}

describe('設計書の究極モードの上限は、プランの行 (ai_plan_feature_caps) で決まると書く (#1912・billing/03 §6.5)', () => {
  it('migration の既定の行は free 0 / pro 2 / family_basic 2 / family_pro 3', () => {
    expect(ultimateCapRowsFromMigration().map(([plan, cap]) => `${plan} ${cap}`).join(' / ')).toBe(
      'free 0 / pro 2 / family_basic 2 / family_pro 3',
    );
  });

  it('operator/06 §5.1 の行は ai_plan_feature_caps と migration の行の値を書き、環境変数は行の無いプランにだけ効くと書く', () => {
    const row = ultimateCapRow();
    expect(row).toContain('ai_plan_feature_caps');
    expect(row).toContain(ultimateCapRowsFromMigration().map(([plan, cap]) => `\`${plan}\` = ${cap}`).join('・'));
    expect(row).toContain('行の無いプラン');
    expect(row).toContain('AI_FEATURE_NOT_IN_PLAN');
    expect(row).not.toContain('全員 (free を含む) が使える');
    expect(row).not.toContain('値は DB に持たず');
  });

  it('family/09 の step2 の ultimate-mode-toggle の行は「全員が使える」と書かない', () => {
    const rows = read(ONBOARDING_STEP2_DOC)
      .split('\n')
      .filter((line) => line.startsWith('| `ultimate-mode-toggle` |'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain('全員が使える');
    expect(rows[0]).toContain('ai_plan_feature_caps');
  });
});

/** #1922 の前の、cron の route の延命の書き方 */
const STALE_KEEPALIVE_PATTERNS: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  ['正典コードの延命の定数', /const LOG_FLUSH_GRACE_MS\s*=/],
  ['正典コードの延命の呼び出し', /waitUntil\(new Promise/],
  ['本文の「waitUntil で 1 秒延命」', /`waitUntil` で 1 秒延命/],
  ['骨格の「waitUntil の延命」', /・`waitUntil` の延命\)/],
  ['テストの一覧の「応答のあと延命する」', /`応答のあと延命する`/],
  ['テストの一覧の「waitUntil が呼ばれる」', /\/ waitUntil が呼ばれる \//],
  ['route の定数の一覧の LOG_FLUSH_GRACE_MS', /route: `ROUTE_NAME`・`LOG_FLUSH_GRACE_MS`/],
];

describe('設計書は cron の route の延命 (#1922 で外した) を書かない', () => {
  const docs = designDocs();

  it('設計書を読めている', () => {
    expect(docs).toContain(OPERATOR_AI_DOC);
    expect(docs).toContain('docs/design/operator/10-logs-and-mail-retry.md');
  });

  it.each(STALE_KEEPALIVE_PATTERNS)('%s が設計書に無い', (_label, pattern) => {
    const hits = docs.flatMap((doc) =>
      read(doc)
        .split('\n')
        .flatMap((line, i) => (pattern.test(line) ? [`${doc}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
