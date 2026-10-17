/**
 * operator/12 (CRON_SECRET のずれの自動検知) の Status の行が、段ごとの実装の有無と食い違わない (#1797 ほかの 10/18 の記録の掃除)
 *
 * 段 A (Edge Function cron-secret-probe。#1863) が main に入ったあとも、記録の掃除の差分が Status を「実装は段 A から」に
 * しようとした (取り込みの再レビューの指摘)。段が main に入るたびに Status が実物から外れないようにする。
 *   1. §12 の段分けの表の段 (A・B・C) と、ここで見る段の印のファイルの段が同じ (段を足したら印も足す)
 *   2. Status が「<段の列> は main に入っている」と書く段 = 印のファイルがある段 (両方向)
 *   3. Status が「<段の列> はこれから」と書く段 = 印のファイルが無い段 (main に入った段が 1 つ以上あり、残りがあるとき)
 * 印のファイルは §12 の各段の「中身」の最初の新設物 (段 A = Edge Function・段 B = migration・段 C = アプリの判定の本体)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = 'docs/design/operator/12-cron-secret-drift-monitor.md';
const MIGRATIONS_DIR = 'supabase/migrations';
/** 段 B の migration のファイル名の末尾 (§12 の `<番号>_cron_secret_drift_monitor.sql`。.down.sql は数えない) */
const STAGE_B_MIGRATION_SUFFIX = '_cron_secret_drift_monitor.sql';

/** 段の名前 → その段が main に入っているか (印のファイルの有無) */
const STAGE_LANDED: Readonly<Record<string, () => boolean>> = {
  A: () => fs.existsSync(path.join(ROOT, 'supabase/functions/cron-secret-probe/index.ts')),
  // `<番号>_cron_secret_drift_monitor.down.sql` は末尾が `…monitor.down.sql` なので、この末尾の一致には入らない
  B: () => fs.readdirSync(path.join(ROOT, MIGRATIONS_DIR)).some((name) => name.endsWith(STAGE_B_MIGRATION_SUFFIX)),
  C: () => fs.existsSync(path.join(ROOT, 'src/lib/ops-alerts/cron-secret-drift.ts')),
};

const doc = (): string => fs.readFileSync(path.join(ROOT, DOC_PATH), 'utf-8');

/** §12 の段分けの表の行 (`| A: Edge | …`) の段の名前 */
function stagesInSection12(text: string): string[] {
  const start = text.indexOf('\n## 12. 段分け');
  const end = text.indexOf('\n## 13.', start);
  expect(start, '§12 の見出しがある').toBeGreaterThanOrEqual(0);
  expect(end, '§13 の見出しがある').toBeGreaterThan(start);
  return [...text.slice(start, end).matchAll(/^\| ([A-Z]): /gm)].map((match) => match[1]);
}

/** Status の行のうち、`phrase` の直前に並ぶ「段 X (…)」の段の名前。phrase が無ければ null */
function stagesBefore(status: string, phrase: string): string[] | null {
  const match = new RegExp(`((?:段 [A-Z] \\([^)]*\\)・?)+) ${phrase}`).exec(status);
  return match === null ? null : [...match[1].matchAll(/段 ([A-Z]) /g)].map((stage) => stage[1]);
}

function statusLine(text: string): string {
  const lines = [...text.matchAll(/^Status: (.*)$/gm)];
  expect(lines, 'Status の行がちょうど 1 つ').toHaveLength(1);
  return lines[0][1];
}

describe('operator/12 の Status と段の実装の有無', () => {
  it('§12 の段分けの表の段と、印のファイルを持つ段が同じ', () => {
    expect(stagesInSection12(doc()).sort()).toEqual(Object.keys(STAGE_LANDED).sort());
  });

  it('Status の「main に入っている」段と「これから」の段が、印のファイルの有無と一致する', () => {
    const status = statusLine(doc());
    const landed = Object.keys(STAGE_LANDED).filter((stage) => STAGE_LANDED[stage]());
    const pending = Object.keys(STAGE_LANDED).filter((stage) => !STAGE_LANDED[stage]());
    expect((stagesBefore(status, 'は main に入っている') ?? []).sort(), `Status: ${status}`).toEqual(landed.sort());
    if (landed.length > 0 && pending.length > 0) {
      expect(stagesBefore(status, 'はこれから')?.sort(), `Status: ${status}`).toEqual(pending.sort());
    }
  });

  it('Status の読み取りが空振りしない (書式の例で確かめる)', () => {
    const example = '設計ゲート通過。段 A (Edge・#1863)・段 B (DB・#1) は main に入っている。段 C (アプリ) はこれから (§12 の順)';
    expect(stagesBefore(example, 'は main に入っている')).toEqual(['A', 'B']);
    expect(stagesBefore(example, 'はこれから')).toEqual(['C']);
    expect(stagesBefore('設計ゲート通過・実装は段 A から', 'は main に入っている')).toBeNull();
  });
});
