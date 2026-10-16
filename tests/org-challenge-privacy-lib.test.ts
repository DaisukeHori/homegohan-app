/**
 * #1688 組織チャレンジの集計の差分から値を逆算させない守りの正典 (src/lib/org-challenge-privacy.ts) のテスト
 *
 * 確かめること (設計 docs/design/org/10-challenge-diff-privacy.md §6・§9.3・§13):
 *   - 状態の遷移表は、利用者の操作で状態が変わる遷移 5 本と 1 対 1 (migration の 1 回限りの NULL → draft は入れない)
 *   - 遷移の判定 (4 × 4 の全組)・順位表を見せない役割・消せる状態
 *   - DB のガードの RAISE を API の 409 に写す
 *   - 管理者だった印の読み取り (service_role のクライアントで、チャレンジ ID と本人の ID で絞る。読めなければ例外)
 *   - 順位表の応答の canonical の Zod (2 形。reason の無い available=false を拒む)
 *   - DB の側 (migration のトリガー・関数・ポリシー) の並びと同じ (contract)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSchemaDb } from './helpers/schema-checked-db';
import { ORG_CHALLENGE_STATUSES } from '@/lib/org-challenges';
import {
  ORG_CHALLENGE_DELETABLE_STATUSES,
  ORG_CHALLENGE_LOCK_ERROR_CODES,
  ORG_CHALLENGE_LOCK_HTTP_STATUS,
  ORG_CHALLENGE_RANKING_EXCLUSIONS_TABLE,
  ORG_CHALLENGE_RANKING_HIDDEN_ROLES,
  ORG_CHALLENGE_STATUS_TRANSITIONS,
  ORG_ROLES,
  RANKING_HIDDEN_REASONS,
  canViewChallengeRanking,
  hasRankingExclusion,
  isOrgChallengeStatusTransitionAllowed,
  mapChallengeLockError,
  rankingSectionSchema,
  type OrgChallengeStatus,
} from '@/lib/org-challenge-privacy';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
/** 本件の migration の名前の末尾 (番号はマージ時に確定するので末尾で探す) */
const STEM_SUFFIX = '_org_challenge_diff_privacy.sql';

/** 状態の遷移 (from → to) を「from>to」の文字列にする (集合の比較用) */
const edge = (from: string, to: string) => `${from}>${to}`;

/**
 * 設計 §9.3 の状態遷移表のうち、利用者の操作で状態が変わる遷移 (API の PUT と PostgREST の直接の UPDATE。経路が違うだけで同じ集合)。
 * migration の 1 回限りの NULL → draft は利用者の操作ではないので入れない
 */
const DESIGN_TRANSITIONS = [
  edge('draft', 'active'),
  edge('draft', 'completed'),
  edge('draft', 'cancelled'),
  edge('active', 'completed'),
  edge('active', 'cancelled'),
];

/** SQL のコメント (-- から行末、/* ... *\/) を取り除く */
const stripSqlComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

function migrationSql(): string {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(STEM_SUFFIX));
  expect(files, `${STEM_SUFFIX} の migration がちょうど 1 本ある`).toHaveLength(1);
  return stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, files[0]), 'utf-8'));
}

/** SQL の中の 'a', 'b' のような文字列の並びを取り出す */
const quotedList = (sql: string): string[] => [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

describe('状態の遷移表 (§9.3)', () => {
  it('ORG_CHALLENGE_STATUS_TRANSITIONS は、§9.3 の利用者の操作で状態が変わる遷移の集合と 1 対 1 (5 本)', () => {
    const edges = Object.entries(ORG_CHALLENGE_STATUS_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => edge(from, to)));
    expect(edges).toHaveLength(DESIGN_TRANSITIONS.length);
    expect(new Set(edges)).toEqual(new Set(DESIGN_TRANSITIONS));
    // 4 つの状態すべてに行がある (終わった状態は空)
    expect(Object.keys(ORG_CHALLENGE_STATUS_TRANSITIONS).sort()).toEqual([...ORG_CHALLENGE_STATUSES].sort());
    expect(ORG_CHALLENGE_STATUS_TRANSITIONS.completed).toEqual([]);
    expect(ORG_CHALLENGE_STATUS_TRANSITIONS.cancelled).toEqual([]);
  });

  const pairs = ORG_CHALLENGE_STATUSES.flatMap((from) => ORG_CHALLENGE_STATUSES.map((to) => [from, to] as const));
  it.each(pairs)('isOrgChallengeStatusTransitionAllowed(%s, %s): 同じ状態は可・それ以外は遷移表のとおり', (from, to) => {
    const expected = from === to || DESIGN_TRANSITIONS.includes(edge(from, to));
    expect(isOrgChallengeStatusTransitionAllowed(from, to)).toBe(expected);
  });

  it('終わった状態 (completed / cancelled) からは、自分以外へは変えられない', () => {
    const ended: OrgChallengeStatus[] = ['completed', 'cancelled'];
    for (const from of ended) {
      for (const to of ORG_CHALLENGE_STATUSES) {
        expect(isOrgChallengeStatusTransitionAllowed(from, to), `${from} → ${to}`).toBe(from === to);
      }
    }
    expect(isOrgChallengeStatusTransitionAllowed('active', 'draft')).toBe(false);
  });

  it('DB のガード (org_challenge_guard_update) が通す遷移は、遷移表の 5 本と同じ。NULL への変更を断り、比較を COALESCE(..., false) で包む', () => {
    const sql = migrationSql();
    const body = sql.match(/CREATE OR REPLACE FUNCTION public\.org_challenge_guard_update\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/);
    expect(body, 'org_challenge_guard_update が見つからない').not.toBeNull();
    const guard = body![1];
    const allowed = [...guard.matchAll(/\(v_from = '([a-z]+)'\s+AND NEW\.status IN \(([^)]*)\)\)/g)].flatMap((m) =>
      quotedList(m[2]).map((to) => edge(m[1], to)),
    );
    expect(new Set(allowed)).toEqual(new Set(DESIGN_TRANSITIONS));
    expect(allowed).toHaveLength(DESIGN_TRANSITIONS.length);
    expect(guard).toMatch(/IF NEW\.status IS NULL OR NOT COALESCE\(/);
    expect(guard).toMatch(/,\s*false\s*\)\s*THEN/);
  });
});

describe('順位表を見せない役割 (今の役割)', () => {
  it('ORG_ROLES は DB の org_role の 3 値。順位表を見せないのは owner と admin', () => {
    expect([...ORG_ROLES]).toEqual(['owner', 'admin', 'member']);
    expect([...ORG_CHALLENGE_RANKING_HIDDEN_ROLES]).toEqual(['owner', 'admin']);
  });

  it.each([
    ['owner', false],
    ['admin', false],
    ['member', true],
    [null, true],
    [undefined, true],
    ['unknown_role', true],
  ])('canViewChallengeRanking(%j) は %s', (role, expected) => {
    expect(canViewChallengeRanking(role)).toBe(expected);
  });

  it('migration の 2 つの NOT IN (順位表の関数と、管理者だった印のトリガー) の並びが ORG_CHALLENGE_RANKING_HIDDEN_ROLES と同じ', () => {
    const sql = migrationSql();
    const ranking = sql.match(/meup\.org_role NOT IN \(([^)]*)\)/);
    const markAdmin = sql.match(/NEW\.org_role NOT IN \(([^)]*)\)/);
    expect(ranking, '順位表の関数の NOT IN が見つからない').not.toBeNull();
    expect(markAdmin, '印のトリガーの NOT IN が見つからない').not.toBeNull();
    expect(quotedList(ranking![1])).toEqual([...ORG_CHALLENGE_RANKING_HIDDEN_ROLES]);
    expect(quotedList(markAdmin![1])).toEqual([...ORG_CHALLENGE_RANKING_HIDDEN_ROLES]);
  });
});

describe('消せる状態 (RESTRICTIVE の削除のポリシー)', () => {
  it('ORG_CHALLENGE_DELETABLE_STATUSES は draft と cancelled で、ORG_CHALLENGE_STATUSES の部分集合', () => {
    expect([...ORG_CHALLENGE_DELETABLE_STATUSES]).toEqual(['draft', 'cancelled']);
    for (const s of ORG_CHALLENGE_DELETABLE_STATUSES) expect(ORG_CHALLENGE_STATUSES).toContain(s);
  });

  it('migration のポリシーの status IN (...) の並びが ORG_CHALLENGE_DELETABLE_STATUSES と同じ', () => {
    const policy = migrationSql().match(
      /CREATE POLICY "Org challenges can be deleted only as draft or cancelled"[\s\S]*?USING \(status IN \(([^)]*)\)\);/,
    );
    expect(policy, '削除のポリシーが見つからない').not.toBeNull();
    expect(quotedList(policy![1])).toEqual([...ORG_CHALLENGE_DELETABLE_STATUSES]);
  });
});

describe('mapChallengeLockError (DB のガードの RAISE → API の 409)', () => {
  it('ORG_CHALLENGE_LOCK_HTTP_STATUS は 409 (前提条件の衝突)', () => {
    expect(ORG_CHALLENGE_LOCK_HTTP_STATUS).toBe(409);
  });

  it.each([
    ['CHALLENGE_STATUS_LOCKED', ORG_CHALLENGE_LOCK_ERROR_CODES.status],
    ['CHALLENGE_PERIOD_LOCKED', ORG_CHALLENGE_LOCK_ERROR_CODES.period],
  ])('P0001 + %s → 409', (message, code) => {
    expect(mapChallengeLockError({ code: 'P0001', message })).toEqual({ code, status: 409 });
  });

  it('P0001 で別の文 → null。別の code → null', () => {
    expect(mapChallengeLockError({ code: 'P0001', message: 'some other raise' })).toBeNull();
    expect(mapChallengeLockError({ code: '23502', message: 'CHALLENGE_STATUS_LOCKED' })).toBeNull();
    expect(mapChallengeLockError({ code: '42501', message: 'permission denied' })).toBeNull();
  });

  it('識別子は migration の RAISE と同じ文字列', () => {
    const sql = migrationSql();
    for (const code of Object.values(ORG_CHALLENGE_LOCK_ERROR_CODES)) {
      expect(sql).toContain(`RAISE EXCEPTION '${code}' USING ERRCODE = 'P0001'`);
    }
  });
});

describe('hasRankingExclusion (管理者だった印の読み取り)', () => {
  const CHALLENGE = '00000000-0000-4000-8000-000000000401';
  const USER = '00000000-0000-4000-8000-000000000003';
  const OTHER = '00000000-0000-4000-8000-000000000004';

  it('行があれば true。表名とチャレンジ ID・本人の ID の絞り込みで読む', async () => {
    const db = createSchemaDb({
      tables: {
        [ORG_CHALLENGE_RANKING_EXCLUSIONS_TABLE]: [{ challenge_id: CHALLENGE, user_id: USER, marked_at: '2026-10-03T00:00:00Z' }],
      },
    });

    await expect(hasRankingExclusion({ from: db.from } as never, { challengeId: CHALLENGE, userId: USER })).resolves.toBe(true);

    const reads = db.recorded(ORG_CHALLENGE_RANKING_EXCLUSIONS_TABLE, 'select');
    expect(reads).toHaveLength(1);
    expect(reads[0].eq).toEqual([
      ['challenge_id', CHALLENGE],
      ['user_id', USER],
    ]);
    expect(ORG_CHALLENGE_RANKING_EXCLUSIONS_TABLE).toBe('organization_challenge_ranking_exclusions');
  });

  it('行が無ければ false (別の人・別のチャレンジの印では true にしない)', async () => {
    const db = createSchemaDb({
      tables: {
        [ORG_CHALLENGE_RANKING_EXCLUSIONS_TABLE]: [{ challenge_id: CHALLENGE, user_id: OTHER, marked_at: '2026-10-03T00:00:00Z' }],
      },
    });

    await expect(hasRankingExclusion({ from: db.from } as never, { challengeId: CHALLENGE, userId: USER })).resolves.toBe(false);
  });

  it('読めなければ例外 (「印が無い」とみなさない)', async () => {
    const db = createSchemaDb({
      tables: {},
      errors: { [ORG_CHALLENGE_RANKING_EXCLUSIONS_TABLE]: { code: 'XX000', message: 'boom' } },
    });

    await expect(hasRankingExclusion({ from: db.from } as never, { challengeId: CHALLENGE, userId: USER })).rejects.toThrow('boom');
  });
});

describe('rankingSectionSchema (GET /api/org/challenges/[id] の ranking)', () => {
  it('reason は not_joined と org_admin の 2 つ', () => {
    expect([...RANKING_HIDDEN_REASONS]).toEqual(['not_joined', 'org_admin']);
  });

  it.each(RANKING_HIDDEN_REASONS)('available=false + reason=%s を受ける', (reason) => {
    expect(rankingSectionSchema.safeParse({ available: false, showNames: false, reason }).success).toBe(true);
  });

  it('available=true の形を受ける', () => {
    const parsed = rankingSectionSchema.safeParse({
      available: true,
      showNames: false,
      rankedCount: 2,
      truncated: false,
      entries: [
        { rank: 1, value: 80, isMe: false, label: '参加者' },
        { rank: 2, value: 50, isMe: true, label: 'あなた' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('reason の無い available=false と、知らない reason を拒む', () => {
    expect(rankingSectionSchema.safeParse({ available: false, showNames: false }).success).toBe(false);
    expect(rankingSectionSchema.safeParse({ available: false, showNames: false, reason: 'other' }).success).toBe(false);
  });
});
