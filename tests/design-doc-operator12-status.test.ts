/**
 * operator/12 (CRON_SECRET のずれの自動検知) の Status が「main に入っている」と書く段は、本当に main に入っている (#1797 ほかの 10/18 の記録の掃除)
 *
 * 段 A (Edge Function cron-secret-probe。#1863) が main に入ったあとも、記録の掃除の差分が Status を「実装は段 A から」に
 * しようとした (取り込みの再レビューの指摘)。Status が実物より先を言わないようにする。見張りは片方向だけ:
 *   1. §12 の段分けの表の段 (A・B・C) と、ここで見る段の印のファイルの段が同じ (段を足したら印も足す)
 *   2. Status が「<段の列> は main に入っている」と書く段は、どれも印のファイルがある (言い過ぎを止める)
 * 逆向き (main に入った段を、Status がまだ「これから」と書く) は見ない。Status は設計正典 (docs/design/**) の行で、
 * 段 B・段 C の実装の PR は docs/design を直せない。逆向きも見ると、その PR が印のファイルを足した時点で必ず赤になり、
 * 正典の PATCH を待つことになる (敵対レビュー R3 の指摘)。Status の書き遅れは記録のみの食い違いで、マージのあとの記録の掃除で直す。
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
/** Status の中で「その段は main に入っている」を表す語 */
const LANDED_PHRASE = 'は main に入っている';

/** 段の名前 → その段が main に入っているか (印のファイルの有無) */
const STAGE_LANDED: Readonly<Record<string, () => boolean>> = {
  A: () => fs.existsSync(path.join(ROOT, 'supabase/functions/cron-secret-probe/index.ts')),
  // 対の down.sql は supabase/rollbacks/ に置く (段 B の migration の 2 行目「戻し方」) ので、この走査 (supabase/migrations) には入らない。
  // 同じ場所に置かれても、末尾が `…monitor.down.sql` なのでこの末尾の一致には入らない
  B:() => fs.readdirSync(path.join(ROOT, MIGRATIONS_DIR)).some((name) => name.endsWith(STAGE_B_MIGRATION_SUFFIX)),
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

/**
 * Status が「main に入っている」と書くのに、印のファイルが無い段 (印を持たない段の名前も含む)。
 * 「これから」と書かれた段が main に入っていても、ここには入れない (片方向)
 */
function overclaimedStages(status: string, isLanded: (stage: string) => boolean): string[] {
  const knownStages = Object.keys(STAGE_LANDED);
  return (stagesBefore(status, LANDED_PHRASE) ?? []).filter((stage) => !knownStages.includes(stage) || !isLanded(stage));
}

function statusLine(text: string): string {
  const lines = [...text.matchAll(/^Status: (.*)$/gm)];
  expect(lines, 'Status の行がちょうど 1 つ').toHaveLength(1);
  return lines[0][1];
}

const landedOnDisk = (stage: string): boolean => STAGE_LANDED[stage]();

describe('operator/12 の Status と段の実装の有無', () => {
  it('§12 の段分けの表の段と、印のファイルを持つ段が同じ', () => {
    expect(stagesInSection12(doc()).sort()).toEqual(Object.keys(STAGE_LANDED).sort());
  });

  it('Status が「main に入っている」と書く段は、どれも印のファイルがある', () => {
    const status = statusLine(doc());
    expect(overclaimedStages(status, landedOnDisk), `Status: ${status}`).toEqual([]);
  });

  it('段の実装の PR が印のファイルを足しても、Status が「これから」のままで赤にならない (片方向)', () => {
    // 段 B・段 C の PR は docs/design を直せない。どの段が main に入っても、いまの Status で言い過ぎにはならない
    expect(overclaimedStages(statusLine(doc()), () => true)).toEqual([]);
    const statusAfterStageA =
      '設計ゲート通過。段 A (Edge・#1863) は main に入っている。段 B (DB)・段 C (アプリ) はこれから (§12 の順)';
    expect(overclaimedStages(statusAfterStageA, (stage) => stage === 'A' || stage === 'B')).toEqual([]);
    expect(overclaimedStages(statusAfterStageA, () => true)).toEqual([]);
  });

  it('Status が main に入っていない段を「main に入っている」と書けば見つける', () => {
    const status = '設計ゲート通過。段 A (Edge・#1863)・段 B (DB・#1) は main に入っている。段 C (アプリ) はこれから';
    expect(overclaimedStages(status, (stage) => stage === 'A')).toEqual(['B']);
    expect(overclaimedStages('段 D (新しい段) は main に入っている', () => true)).toEqual(['D']);
  });

  it('Status の読み取りが空振りしない (書式の例で確かめる)', () => {
    const example = '設計ゲート通過。段 A (Edge・#1863)・段 B (DB・#1) は main に入っている。段 C (アプリ) はこれから (§12 の順)';
    expect(stagesBefore(example, LANDED_PHRASE)).toEqual(['A', 'B']);
    expect(stagesBefore(example, 'はこれから')).toEqual(['C']);
    expect(stagesBefore('設計ゲート通過・実装は段 A から', LANDED_PHRASE)).toBeNull();
  });
});
