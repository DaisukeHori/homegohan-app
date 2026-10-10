/**
 * #1132 組織チャレンジの共通の定義 (src/lib/org-challenges.ts) のテスト
 *
 * 確かめること:
 *   - 使える種類は 3 つ (朝食・野菜スコア・自炊)。歩数・体重・カスタムは使えない (健康データの同意の仕組みができるまで)
 *   - 画面・API の定義と、DB の定義がずれていない (contract):
 *       * 種類: DB の関数 update_org_challenge_progress が計算する種類 / 表の CHECK 制約の種類
 *       * 最小人数: DB の関数 get_org_challenge_aggregates の最小人数 (5)
 *       * 状態: 表の CHECK 制約の状態
 *   - 順位表に表示名を出すかどうか (環境変数 ORG_CHALLENGE_SHOW_NAMES。未設定なら出さない)
 *   - 日付: 実在する YYYY-MM-DD か、JST の今日 (UTC の日付とずれる時間帯)
 *   - 表示用の整形 (値・参加者数)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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

const ROOT = path.resolve(__dirname, '..');
/** この機能の migration。version (先頭の 14 桁) は付け替えられることがあるので、名前の後ろ半分で探す */
function readMigration(): string {
  const dir = path.join(ROOT, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{14}_org_challenge_progress\.sql$/.test(f));
  if (files.length !== 1) throw new Error(`org_challenge_progress の migration が ${files.length} 個ある: ${files.join(', ')}`);
  return fs.readFileSync(path.join(dir, files[0]), 'utf-8');
}
const MIGRATION = readMigration();
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
    const m = MIGRATION.match(/AND c\.challenge_type IN \(([^)]+)\)/);
    expect(m, 'migration に種類の絞り込みが見つからない').not.toBeNull();
    expect(quotedList(m![1]).sort()).toEqual([...ORG_CHALLENGE_TYPES].sort());
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
    const m = MIGRATION.match(/SELECT (\d+) AS min_participants/);
    expect(m, 'migration に最小人数が見つからない').not.toBeNull();
    expect(ORG_CHALLENGE_MIN_PARTICIPANTS).toBe(Number(m![1]));
    expect(ORG_CHALLENGE_MIN_PARTICIPANTS).toBe(5);
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
    expect(showParticipantNames({})).toBe(false);
    expect(showParticipantNames({ ORG_CHALLENGE_SHOW_NAMES: undefined })).toBe(false);
    expect(showParticipantNames({ ORG_CHALLENGE_SHOW_NAMES: '' })).toBe(false);
    expect(showParticipantNames({ ORG_CHALLENGE_SHOW_NAMES: '   ' })).toBe(false);
  });

  it.each(['1', 'true', 'on', 'yes', 'TRUE', 'On', ' yes ', 'YES\n'])('%j なら出す', (value) => {
    expect(showParticipantNames({ ORG_CHALLENGE_SHOW_NAMES: value })).toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', 'y', 'enabled', '2', 'null', 'undefined'])('%j なら出さない', (value) => {
    expect(showParticipantNames({ ORG_CHALLENGE_SHOW_NAMES: value })).toBe(false);
  });

  it('引数を省略すると process.env を読む', () => {
    const original = process.env.ORG_CHALLENGE_SHOW_NAMES;
    try {
      delete process.env.ORG_CHALLENGE_SHOW_NAMES;
      expect(showParticipantNames()).toBe(false);
      process.env.ORG_CHALLENGE_SHOW_NAMES = 'on';
      expect(showParticipantNames()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.ORG_CHALLENGE_SHOW_NAMES;
      else process.env.ORG_CHALLENGE_SHOW_NAMES = original;
    }
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

  it('人数が無い (API が最小人数に満たないとき null で返す) ときは「5人未満」', () => {
    expect(formatParticipantCount(null)).toBe('5人未満');
    expect(formatParticipantCount(undefined)).toBe('5人未満');
    expect(formatParticipantCount(Number.NaN)).toBe('5人未満');
  });

  it('API が返した最小人数があれば、その人数で「未満」と表示する', () => {
    expect(formatParticipantCount(null, 10)).toBe('10人未満');
  });
});
