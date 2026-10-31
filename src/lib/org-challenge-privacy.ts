// src/lib/org-challenge-privacy.ts
// #1688 組織チャレンジの集計の差分から、やめた人の値を逆算させない守りの正典 (定数・遷移表・Zod・純関数)。
// DB 側の対 (遷移表・順位表を伏せる役割) は migration *_org_challenge_diff_privacy.sql のトリガーと関数。
import { z } from 'zod';
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { ORG_CHALLENGE_STATUSES } from '@/lib/org-challenges';

export type OrgChallengeStatus = (typeof ORG_CHALLENGE_STATUSES)[number];

/** 組織の役割 (DB の org_role_enum と同じ 3 値) */
export const ORG_ROLES = ['owner', 'admin', 'member'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/**
 * 順位表を見せない役割 = 組織の管理者 (メンバーを組織から外せる人。外した人の行が消えるのを見せない)。
 * DB の関数 get_org_challenge_ranking の `meup.org_role NOT IN ('owner', 'admin')` と、トリガー関数
 * org_challenge_mark_admin の `NEW.org_role NOT IN ('owner', 'admin')` と同じ並び (contract テストが突合する)
 */
export const ORG_CHALLENGE_RANKING_HIDDEN_ROLES = ['owner', 'admin'] as const satisfies readonly OrgRole[];

/** 今の役割だけの判定。管理者だった印 (hasRankingExclusion) は別に見る */
export function canViewChallengeRanking(orgRole: string | null | undefined): boolean {
  return !(ORG_CHALLENGE_RANKING_HIDDEN_ROLES as readonly string[]).includes(orgRole ?? '');
}

/** 管理者だった印の表 (§5.1 の 3.)。読み書きは service_role だけ */
export const ORG_CHALLENGE_RANKING_EXCLUSIONS_TABLE = 'organization_challenge_ranking_exclusions';

/**
 * そのチャレンジに、その人の「管理者だった印」があるか。認可 (requireOrgMember) を通したあとに service_role のクライアントで呼ぶ。
 * 読めなかったときは例外 (呼び出し側の catch で 500。「印が無い」とみなして順位表を返すことはしない)
 */
export async function hasRankingExclusion(
  admin: Pick<SupabaseClient, 'from'>,
  args: { challengeId: string; userId: string },
): Promise<boolean> {
  const { data, error } = await admin
    .from(ORG_CHALLENGE_RANKING_EXCLUSIONS_TABLE)
    .select('challenge_id')
    .eq('challenge_id', args.challengeId)
    .eq('user_id', args.userId)
    .maybeSingle();
  if (error) {
    throw new Error(`順位表を伏せる印の取得に失敗しました: ${error.message}`);
  }
  return data !== null;
}

/**
 * 利用者の権限 (authenticated) で消せるチャレンジの状態。RESTRICTIVE ポリシー
 * "Org challenges can be deleted only as draft or cancelled" の `status IN ('draft', 'cancelled')` と同じ並び (contract テストが突合する)
 */
export const ORG_CHALLENGE_DELETABLE_STATUSES = ['draft', 'cancelled'] as const satisfies readonly OrgChallengeStatus[];

/** 状態 × 遷移先 (§9.3 の状態遷移表と 1 対 1。DB のトリガー trg_org_challenge_guard_update (関数 org_challenge_guard_update) と同じ) */
export const ORG_CHALLENGE_STATUS_TRANSITIONS: Readonly<Record<OrgChallengeStatus, readonly OrgChallengeStatus[]>> = {
  draft: ['active', 'completed', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

/** 同じ状態の指定は「変えない」(可)。それ以外は遷移表のとおり */
export function isOrgChallengeStatusTransitionAllowed(from: OrgChallengeStatus, to: OrgChallengeStatus): boolean {
  return from === to || ORG_CHALLENGE_STATUS_TRANSITIONS[from].includes(to);
}

/** DB のトリガーが RAISE する識別子 (ERRCODE は P0001)。API はこれを 409 に写す */
export const ORG_CHALLENGE_LOCK_ERROR_CODES = {
  status: 'CHALLENGE_STATUS_LOCKED',
  period: 'CHALLENGE_PERIOD_LOCKED',
} as const;
export type OrgChallengeLockErrorCode = (typeof ORG_CHALLENGE_LOCK_ERROR_CODES)[keyof typeof ORG_CHALLENGE_LOCK_ERROR_CODES];

/** PostgreSQL の RAISE EXCEPTION の既定の SQLSTATE (raise_exception) */
const PG_RAISE_EXCEPTION_SQLSTATE = 'P0001';
/** 状態・期間の変更を断る HTTP ステータス (前提条件の衝突。既存の CHALLENGE_NOT_ACTIVE / CHALLENGE_ENDED と同じ) */
export const ORG_CHALLENGE_LOCK_HTTP_STATUS = 409;

/** DB のガードの RAISE を API の応答 (code・status) に写す。ガード由来でなければ null */
export function mapChallengeLockError(
  error: Pick<PostgrestError, 'code' | 'message'>,
): { code: OrgChallengeLockErrorCode; status: number } | null {
  if (error.code !== PG_RAISE_EXCEPTION_SQLSTATE) return null;
  const code = Object.values(ORG_CHALLENGE_LOCK_ERROR_CODES).find((c) => error.message.includes(c));
  return code ? { code, status: ORG_CHALLENGE_LOCK_HTTP_STATUS } : null;
}

/** 順位表を返さない理由 (メンバー向け API の ranking.reason) */
export const RANKING_HIDDEN_REASONS = ['not_joined', 'org_admin'] as const;
export type RankingHiddenReason = (typeof RANKING_HIDDEN_REASONS)[number];

export const rankingEntrySchema = z.object({
  rank: z.number().int().positive(),
  value: z.number(),
  isMe: z.boolean(),
  label: z.string(),
});

/** GET /api/org/challenges/[id] の ranking (canonical。画面とテストはこの形で読む) */
export const rankingSectionSchema = z.union([
  z.object({ available: z.literal(false), showNames: z.boolean(), reason: z.enum(RANKING_HIDDEN_REASONS) }),
  z.object({
    available: z.literal(true),
    showNames: z.boolean(),
    rankedCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    entries: z.array(rankingEntrySchema),
  }),
]);
export type RankingSection = z.infer<typeof rankingSectionSchema>;
