/**
 * #1132 組織チャレンジの共通の定義 (src/lib/org-challenges.ts) のテスト
 *
 * 確かめること:
 *   - 使える種類は 3 つ (朝食・野菜スコア・自炊)。歩数・体重・カスタムは使えない (健康データの同意の仕組みができるまで)
 *   - 画面・API の定義と、DB の定義がずれていない (contract):
 *       * 種類: DB の関数 update_org_challenge_progress が計算する種類 / 表の CHECK 制約の種類
 *       * 最小人数: DB の関数 get_org_challenge_aggregates の最小人数 (10。#1600)
 *       * 参加の INSERT ポリシー (#1238 / #1600 の「Users can join challenges」) が許す種類 = 使える種類
 *       * 順位表の人数: DB の関数 get_org_challenge_ranking の既定の人数 (cfg.default_limit) が RANKING_ENTRY_LIMIT と同じ。
 *         上限 (cfg.max_limit = 100) 以下。人数の数字は cfg にだけ書き、式には直に書かない
 *       * 状態: 表の CHECK 制約の状態
 *   - 順位表に表示名を出すかどうか (環境変数 ORG_CHALLENGE_SHOW_NAMES。未設定なら出さない)
 *   - 日付: 実在する YYYY-MM-DD か、JST の今日 (UTC の日付とずれる時間帯)
 *   - 表示用の整形 (値・参加者数)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as shared from '@homegohan/shared';
import {
  DISABLED_ORG_CHALLENGE_TYPES,
  ORG_CHALLENGE_MEMBER_STATUSES,
  ORG_CHALLENGE_MIN_PARTICIPANTS,
  ORG_CHALLENGE_STATUSES,
  ORG_CHALLENGE_TYPES,
  ORG_CHALLENGE_TYPE_LABELS,
  ORG_CHALLENGE_TYPE_META,
  RANKING_ENTRY_LIMIT,
  RANKING_OTHER_LABEL,
  RANKING_SELF_LABEL,
  formatOrgChallengeValue,
  formatParticipantCount,
  isIsoDate,
  isOrgChallengeStatus,
  isOrgChallengeType,
  showParticipantNames,
  todayJst,
} from '@/lib/org-challenges';
import { PUBLIC_ENV_VARS, SERVER_ENV_VARS } from '@/lib/env';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`)。番号順に並べる */
const MIGRATION_FILES = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{14}_.+\.sql$/.test(f))
  .sort();

/** 番号順で最後に、パターン (コメントを除いた文面に対して) に当たる migration の文面 (流した後に残る定義) */
function lastMigrationMatching(pattern: RegExp, what: string): string {
  const found = MIGRATION_FILES.filter((f) =>
    pattern.test(stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'))),
  );
  if (found.length === 0) throw new Error(`${what} を定義する migration が無い`);
  return fs.readFileSync(path.join(MIGRATIONS_DIR, found[found.length - 1]), 'utf-8');
}

/**
 * 関数 1 本を最後に定義した migration の文面。
 * #1132 (*_org_challenge_progress.sql) のあと、#1600 (*_org_challenge_min10_join_policy.sql) が
 * get_org_challenge_aggregates を作り直したので、ファイル名ではなく定義で探す
 */
function definingMigration(name: string): string {
  return lastMigrationMatching(new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${name}\(`), `関数 ${name}`);
}
const BASELINE = fs.readFileSync(path.join(ROOT, 'supabase/baseline/prod_schema.sql'), 'utf-8');

/** SQL の中の 'a', 'b', 'c' のような文字列の並びを取り出す */
function quotedList(sql: string): string[] {
  return [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('使える種類と使えない種類', () => {
  it('使えるのは朝食・野菜スコア・自炊の 3 つ。歩数・体重・カスタムは使えない', () => {
    expect([...ORG_CHALLENGE_TYPES]).toEqual(['breakfast_rate', 'veg_score', 'cooking_rate']);
    expect([...DISABLED_ORG_CHALLENGE_TYPES]).toEqual(['steps', 'weight_loss', 'custom']);
  });

  it.each(['breakfast_rate', 'veg_score', 'cooking_rate'])('%s は使える種類', (type) => {
    expect(isOrgChallengeType(type)).toBe(true);
  });

  it.each(['steps', 'weight_loss', 'custom', 'veggie_score', 'homecook_rate', 'BREAKFAST_RATE', ' breakfast_rate', '', 'unknown'])(
    '%j は使えない種類',
    (type) => {
      expect(isOrgChallengeType(type)).toBe(false);
    },
  );

  it.each([undefined, null, 0, 1, true, {}, [], ['breakfast_rate']])('文字列でない値 (%j) は使えない種類', (value) => {
    expect(isOrgChallengeType(value)).toBe(false);
  });

  it('使える種類と使えない種類は、重ならず、合わせると表の CHECK 制約 (organization_challenges_challenge_type_check) の種類と同じ', () => {
    const m = BASELINE.match(/organization_challenges_challenge_type_check" CHECK \(\("challenge_type" = ANY \(ARRAY\[([^\]]+)\]/);
    expect(m, '本番スキーマに CHECK 制約が見つからない').not.toBeNull();
    const dbTypes = quotedList(m![1]);

    const enabled = new Set<string>(ORG_CHALLENGE_TYPES);
    const disabled = new Set<string>(DISABLED_ORG_CHALLENGE_TYPES);
    for (const type of enabled) expect(disabled.has(type), `${type} が両方に入っている`).toBe(false);
    expect([...enabled, ...disabled].sort()).toEqual([...dbTypes].sort());
  });

  it('DB の関数 update_org_challenge_progress が計算する種類は、使える種類と同じ', () => {
    const m = functionBody(definingMigration('update_org_challenge_progress'), 'update_org_challenge_progress').match(
      /AND c\.challenge_type IN \(([^)]+)\)/,
    );
    expect(m, 'migration に種類の絞り込みが見つからない').not.toBeNull();
    expect(quotedList(m![1]).sort()).toEqual([...ORG_CHALLENGE_TYPES].sort());
  });

  it('参加の INSERT ポリシー「Users can join challenges」が許す種類は、使える種類と同じ (#1600。API の CHALLENGE_TYPE_DISABLED と同じ条件)', () => {
    const policyPattern = /CREATE POLICY "Users can join challenges"/;
    const sql = stripSqlComments(lastMigrationMatching(policyPattern, '参加の INSERT ポリシー'));
    const policy = sql.slice(sql.search(policyPattern)).split(';')[0];
    const m = policy.match(/oc\.challenge_type IN \(([^)]+)\)/);
    expect(m, 'ポリシーに種類の絞り込みが見つからない').not.toBeNull();
    expect(quotedList(m![1]).sort()).toEqual([...ORG_CHALLENGE_TYPES].sort());
    // API と同じ、開催中・終了日 (JST)・部署の限定も見る
    expect(policy).toMatch(/oc\.status = 'active'/);
    expect(policy).toMatch(/oc\.end_date >= \(now\(\) AT TIME ZONE 'Asia\/Tokyo'\)::date/);
    expect(policy).toMatch(/oc\.department_id IS NULL OR oc\.department_id = up\.department_id/);
  });

  it('使える種類には、名前・単位・説明・目標値の範囲がある。名前の一覧は使えない種類も持つ', () => {
    for (const type of ORG_CHALLENGE_TYPES) {
      const meta = ORG_CHALLENGE_TYPE_META[type];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.unit.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
      expect(meta.targetMin).toBeLessThan(meta.targetMax);
      if (meta.defaultTarget !== null) {
        expect(meta.defaultTarget).toBeGreaterThanOrEqual(meta.targetMin);
        expect(meta.defaultTarget).toBeLessThanOrEqual(meta.targetMax);
      }
      expect(ORG_CHALLENGE_TYPE_LABELS[type]).toBe(meta.label);
    }
    for (const type of DISABLED_ORG_CHALLENGE_TYPES) {
      expect(ORG_CHALLENGE_TYPE_LABELS[type], `${type} の名前`).toBeTruthy();
    }
  });

  it('野菜スコアの目標値は 0〜100 まで入れられる (写真の解析は 0〜100 点で記録される)。点数の範囲を説明に書かない', () => {
    const meta = ORG_CHALLENGE_TYPE_META.veg_score;
    expect(meta.targetMin).toBe(0);
    expect(meta.targetMax).toBe(100);
    expect(meta.description).not.toMatch(/1〜5|0〜5/);
  });
});

describe('最小人数 (DB の関数と同じ値)', () => {
  it('ORG_CHALLENGE_MIN_PARTICIPANTS は、DB の関数 get_org_challenge_aggregates の最小人数と同じ', () => {
    const m = functionBody(definingMigration('get_org_challenge_aggregates'), 'get_org_challenge_aggregates').match(
      /SELECT (\d+) AS min_participants/,
    );
    expect(m, 'migration に最小人数が見つからない').not.toBeNull();
    expect(ORG_CHALLENGE_MIN_PARTICIPANTS).toBe(Number(m![1]));
    // 要件書 §6.4 の匿名化集計の最低人数 (#1600)
    expect(ORG_CHALLENGE_MIN_PARTICIPANTS).toBe(10);
  });

  it('Web の定数・整形は @homegohan/shared の同じもの (共通のパッケージと値が分かれない)', () => {
    expect(ORG_CHALLENGE_MIN_PARTICIPANTS).toBe(shared.ORG_CHALLENGE_MIN_PARTICIPANTS);
    expect(formatParticipantCount).toBe(shared.formatParticipantCount);
  });
});

/** SQL のコメント (-- から行末、/* ... *\/) を取り除く。コメントの中の語を拾わないように */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/** migration の中の関数 1 本の本体 ($$ ... $$)。コメントは取り除く */
function functionBody(sql: string, name: string): string {
  const code = stripSqlComments(sql);
  const m = code.match(new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${name}\([\s\S]*?\$\$([\s\S]*?)\$\$`));
  if (!m) throw new Error(`migration に関数 ${name} が見つからない`);
  return m[1];
}

/** database.types.ts の、表 1 つの Row の列名 */
function rowColumnsOf(types: string, table: string): string[] {
  const m = types.match(new RegExp(String.raw`\n      ${table}: \{\n        Row: \{\n([\s\S]*?)\n        \}`));
  if (!m) throw new Error(`database.types.ts に ${table} の Row が見つからない`);
  return [...m[1].matchAll(/^\s+([a-z_0-9]+)\??:/gm)].map((c) => c[1]);
}

describe('順位表の人数 (DB の関数 get_org_challenge_ranking の cfg と同じ値)', () => {
  /** 順位表の上限の人数 (migration の cfg.max_limit)。1 回に返す行数を、上位だけを見せる人数で打ち切る */
  const EXPECTED_MAX_LIMIT = 100;
  const RANKING_MIGRATION = definingMigration('get_org_challenge_ranking');
  const body = functionBody(RANKING_MIGRATION, 'get_org_challenge_ranking');
  const cfg = body.match(/SELECT (\d+) AS default_limit, (\d+) AS max_limit/);

  it('既定の人数 (cfg.default_limit) は RANKING_ENTRY_LIMIT と同じ。上限 (cfg.max_limit) は 100 で、既定の人数以上', () => {
    expect(cfg, 'get_org_challenge_ranking に cfg (default_limit / max_limit) が見つからない').not.toBeNull();
    expect(Number(cfg![1])).toBe(RANKING_ENTRY_LIMIT);
    expect(Number(cfg![2])).toBe(EXPECTED_MAX_LIMIT);
    expect(RANKING_ENTRY_LIMIT).toBeLessThanOrEqual(EXPECTED_MAX_LIMIT);
  });

  it('人数のしぼり込みは cfg を読む。引数の既定値は NULL (数字を引数と式の 2 か所に書かない)', () => {
    expect(body).toMatch(/LEAST\(GREATEST\(COALESCE\(p_limit, cfg\.default_limit\), 1\), cfg\.max_limit\)/);
    const signature = stripSqlComments(RANKING_MIGRATION).match(/CREATE OR REPLACE FUNCTION public\.get_org_challenge_ranking\(([\s\S]*?)\)\s*RETURNS/);
    expect(signature, 'get_org_challenge_ranking の引数が見つからない').not.toBeNull();
    expect(signature![1]).toMatch(/p_limit\s+integer DEFAULT NULL\b/);
    expect(signature![1]).not.toMatch(/DEFAULT \d/);
  });

  it.each([
    ['get_org_challenge_ranking', /SELECT \d+ AS default_limit, \d+ AS max_limit/],
    ['get_org_challenge_aggregates', /SELECT \d+ AS min_participants/],
  ])('%s の本体には、cfg の外に人数の数字が無い (1 = 「1 人以上」と小数第 1 位の丸めだけ)', (name, cfgPattern) => {
    const definition = functionBody(definingMigration(name), name);
    const rest = definition.replace(cfgPattern, '');
    expect(definition).toMatch(cfgPattern);
    const numbers = [...rest.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)].map((m) => m[0]);
    expect(new Set(numbers)).toEqual(new Set(['1']));
  });
});

describe('集計に数えない記録 (お試しの記録・運営が隠した食事)。比較ランキングの集計と同じ決まり', () => {
  const body = functionBody(definingMigration('update_org_challenge_progress'), 'update_org_challenge_progress');
  const TYPES = fs.readFileSync(path.join(ROOT, 'src/types/database.types.ts'), 'utf-8');
  const SEGMENT_STATS = fs.readFileSync(path.join(ROOT, 'supabase/functions/calculate-segment-stats/index.ts'), 'utf-8');

  it('update_org_challenge_progress は、ハンズオンのお試しの記録 (user_daily_meals.is_sandbox = true) を読まない', () => {
    expect(body).toMatch(/LEFT JOIN public\.user_daily_meals AS d\s+ON d\.user_id = m\.user_id\s+AND d\.is_sandbox = false/);
    // 比較ランキングの集計 (calculate-segment-stats) の planned_meals の読み込みと同じ絞り込み (#1500)
    expect(SEGMENT_STATS).toMatch(/\.from\('planned_meals'\)[\s\S]{0,400}\.eq\('user_daily_meals\.is_sandbox', false\)/);
  });

  it('update_org_challenge_progress は public.meals を読まない (運営が隠す食事 hidden_at は meals の列。読むなら hidden_at IS NULL で絞ること)', () => {
    expect(body).not.toMatch(/\bpublic\.meals\b/);
    expect(body).toMatch(/\bpublic\.planned_meals\b/);
    expect(rowColumnsOf(TYPES, 'meals')).toContain('hidden_at');
  });

  it('集計が読む planned_meals / user_daily_meals には、運営が隠す列 (hidden_at) が無い。足したら、この集計でも隠した行を数えないようにする', () => {
    for (const table of ['planned_meals', 'user_daily_meals']) {
      const columns = rowColumnsOf(TYPES, table);
      expect(columns, `${table} の列が読めていない`).toContain('id');
      expect(columns, `${table} に hidden_at が足された。update_org_challenge_progress でも hidden_at IS NULL で絞ること`).not.toContain(
        'hidden_at',
      );
    }
    expect(rowColumnsOf(TYPES, 'user_daily_meals')).toContain('is_sandbox');
  });
});

describe('チャレンジの状態', () => {
  it('状態は表の CHECK 制約 (organization_challenges_status_check) と同じ', () => {
    const m = BASELINE.match(/organization_challenges_status_check" CHECK \(\("status" = ANY \(ARRAY\[([^\]]+)\]/);
    expect(m, '本番スキーマに CHECK 制約が見つからない').not.toBeNull();
    expect([...ORG_CHALLENGE_STATUSES].sort()).toEqual(quotedList(m![1]).sort());
  });

  it('isOrgChallengeStatus は DB が受け付ける状態だけ true', () => {
    for (const status of ORG_CHALLENGE_STATUSES) expect(isOrgChallengeStatus(status)).toBe(true);
    for (const value of ['', 'ACTIVE', 'finished', 'archived', undefined, null, 1, {}]) {
      expect(isOrgChallengeStatus(value)).toBe(false);
    }
  });

  it('メンバーに見せるのは開催中と終了だけ (下書き・中止は見せない)', () => {
    expect([...ORG_CHALLENGE_MEMBER_STATUSES]).toEqual(['active', 'completed']);
  });
});

describe('順位表に表示名を出すか (ORG_CHALLENGE_SHOW_NAMES)', () => {
  it('未設定なら出さない (オーナーの確認が済むまでの既定)', () => {
    expect(showParticipantNames(undefined)).toBe(false);
    expect(showParticipantNames('')).toBe(false);
    expect(showParticipantNames('   ')).toBe(false);
  });

  it.each(['1', 'true', 'on', 'yes', 'TRUE', 'On', ' yes ', 'YES\n'])('%j なら出す', (value) => {
    expect(showParticipantNames(value)).toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', 'y', 'enabled', '2', 'null', 'undefined'])('%j なら出さない', (value) => {
    expect(showParticipantNames(value)).toBe(false);
  });

  it('引数を省略すると、呼んだ時点の process.env.ORG_CHALLENGE_SHOW_NAMES を読む (未設定なら出さない・1 / true / on / yes だけ出す)', () => {
    const original = process.env.ORG_CHALLENGE_SHOW_NAMES;
    try {
      delete process.env.ORG_CHALLENGE_SHOW_NAMES;
      expect(showParticipantNames()).toBe(false);
      process.env.ORG_CHALLENGE_SHOW_NAMES = 'on';
      expect(showParticipantNames()).toBe(true);
      process.env.ORG_CHALLENGE_SHOW_NAMES = ' YES ';
      expect(showParticipantNames()).toBe(true);
      process.env.ORG_CHALLENGE_SHOW_NAMES = 'off';
      expect(showParticipantNames()).toBe(false);
      process.env.ORG_CHALLENGE_SHOW_NAMES = '';
      expect(showParticipantNames()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.ORG_CHALLENGE_SHOW_NAMES;
      else process.env.ORG_CHALLENGE_SHOW_NAMES = original;
    }
  });

  it('環境変数の一覧 (src/lib/env.ts) に、任意・サーバー用・値を読むのは src/lib/org-challenges.ts だけとして載っている (#1142 の検査 6〜9 の対象)', () => {
    const spec = SERVER_ENV_VARS.ORG_CHALLENGE_SHOW_NAMES;
    expect(spec.required).toBe(false);
    expect(spec.readOnlyBy).toBe('src/lib/org-challenges.ts');
    expect(spec.whenMissing).toContain('出さない');
    expect(Object.keys(PUBLIC_ENV_VARS)).not.toContain('ORG_CHALLENGE_SHOW_NAMES');
  });

  it('名前を書いて読む (process.env をまるごと受け取らない — #1142 の検査 9)', () => {
    // コメントを除いたコードで見る (説明のコメントにも変数名が出てくるため)
    const code = fs
      .readFileSync(path.join(ROOT, 'src/lib/org-challenges.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/export function showParticipantNames\(value: string \| undefined = process\.env\.ORG_CHALLENGE_SHOW_NAMES\)/);
    // process.env を名前なしで使う箇所 (`process.env` の直後が `.名前` でない) が無い
    expect(code).not.toMatch(/process\.env(?!\.[A-Z_])/);
  });

  it('順位表の表示用の定数', () => {
    expect(RANKING_SELF_LABEL).toBe('あなた');
    expect(RANKING_OTHER_LABEL).toBe('参加者');
    expect(RANKING_ENTRY_LIMIT).toBe(20);
  });
});

describe('isIsoDate', () => {
  it.each(['2026-10-08', '2024-02-29', '2000-01-01', '2026-12-31'])('%s は実在する日付', (value) => {
    expect(isIsoDate(value)).toBe(true);
  });

  it.each([
    '2026-02-30',
    '2025-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-10-00',
    '2026-10-32',
    '2026-1-1',
    '2026/10/08',
    '20261008',
    '2026-10-08T00:00:00Z',
    ' 2026-10-08',
    '',
  ])('%j は日付として受け付けない', (value) => {
    expect(isIsoDate(value)).toBe(false);
  });

  it.each([undefined, null, 20261008, true, {}, new Date('2026-10-08')])('文字列でない値 (%j) は受け付けない', (value) => {
    expect(isIsoDate(value)).toBe(false);
  });
});

describe('todayJst (JST の暦日。DB の関数 update_org_challenge_progress と同じ決め方)', () => {
  it('UTC の 14:59:59 はまだ JST の同じ日、UTC の 15:00:00 から JST の翌日', () => {
    expect(todayJst(new Date('2026-10-08T14:59:59Z'))).toBe('2026-10-08');
    expect(todayJst(new Date('2026-10-08T15:00:00Z'))).toBe('2026-10-09');
  });

  it('UTC の日付とずれる時間帯 (JST の 0:00〜8:59) でも JST の日付になる', () => {
    expect(todayJst(new Date('2026-10-08T00:00:00Z'))).toBe('2026-10-08'); // JST 9:00
    expect(todayJst(new Date('2026-10-07T20:30:00Z'))).toBe('2026-10-08'); // JST 5:30 (UTC では前日)
  });

  it('月末・年末・うるう日をまたぐ', () => {
    expect(todayJst(new Date('2026-12-31T15:00:00Z'))).toBe('2027-01-01');
    expect(todayJst(new Date('2024-02-28T15:00:00Z'))).toBe('2024-02-29');
    expect(todayJst(new Date('2024-02-29T15:00:00Z'))).toBe('2024-03-01');
  });

  it('引数を省略すると今の日付 (YYYY-MM-DD の形)', () => {
    expect(todayJst()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatOrgChallengeValue', () => {
  it('単位をつける。整数はそのまま、小数は小数第 1 位', () => {
    expect(formatOrgChallengeValue('breakfast_rate', 66.7)).toBe('66.7%');
    expect(formatOrgChallengeValue('breakfast_rate', 100)).toBe('100%');
    expect(formatOrgChallengeValue('cooking_rate', 0)).toBe('0%');
    expect(formatOrgChallengeValue('veg_score', 3.66)).toBe('3.7点');
    expect(formatOrgChallengeValue('veg_score', 62)).toBe('62点');
  });

  it('値が無い・数でないときは「-」', () => {
    expect(formatOrgChallengeValue('breakfast_rate', null)).toBe('-');
    expect(formatOrgChallengeValue('breakfast_rate', undefined)).toBe('-');
    expect(formatOrgChallengeValue('breakfast_rate', Number.NaN)).toBe('-');
    expect(formatOrgChallengeValue('breakfast_rate', Number.POSITIVE_INFINITY)).toBe('-');
  });

  it('使えない種類・知らない種類は、単位なし', () => {
    expect(formatOrgChallengeValue('steps', 8000)).toBe('8000');
    expect(formatOrgChallengeValue('unknown', 1.25)).toBe('1.3');
  });
});

describe('formatParticipantCount', () => {
  it('人数があればそのまま (0 人も 0 人)', () => {
    expect(formatParticipantCount(12)).toBe('12人');
    expect(formatParticipantCount(5)).toBe('5人');
    expect(formatParticipantCount(0)).toBe('0人');
  });

  it('人数が無い (API が最小人数に満たないとき null で返す) ときは「10人未満」', () => {
    expect(formatParticipantCount(null)).toBe('10人未満');
    expect(formatParticipantCount(undefined)).toBe('10人未満');
    expect(formatParticipantCount(Number.NaN)).toBe('10人未満');
  });

  it('API が返した最小人数があれば、その人数で「未満」と表示する', () => {
    expect(formatParticipantCount(null, 15)).toBe('15人未満'); // 既定 (10) と違う値で、API の値が使われることを確かめる
  });
});
