/**
 * 組織チャレンジの、Web とモバイルで共通の決まり (#1132)
 *
 * 管理者に参加者数・平均を見せるのに必要な最小人数は、サーバー・Web・モバイルの 3 か所で同じ値を使うため、
 * 置き場はこのファイルの 1 つにする (Web は src/lib/org-challenges.ts から、モバイルは管理画面
 * apps/mobile/app/(org)/org/challenges.tsx から読む)。
 */

/**
 * 参加者数・平均を画面に出すのに必要な最小人数の、説明文用の値。
 * 実際の判定は DB の関数 get_org_challenge_aggregates (それを最後に定義した migration。#1600 からは
 * supabase/migrations/*_org_challenge_min10_join_policy.sql の `SELECT 10 AS min_participants`) が行い、
 * API は判定に使った値 (minParticipants) を返す。この定数は、その値が来ないときの説明文の既定値で、
 * DB の関数と同じ値にそろえる (packages/shared/src/org-challenges.test.ts と tests/org-challenges-lib.test.ts が検査する)。
 * 少人数だと、誰が参加しているか・誰の値かが分かってしまうのを防ぐための下限。
 * 10 人は、要件書 (docs/requirements/02-organization-management.md §6.4) の匿名化集計の最低人数 (#1600)。
 */
export const ORG_CHALLENGE_MIN_PARTICIPANTS = 10;

/** 参加者数を画面に出す形にする。最小人数に満たない (API が null で返す) ときは「10人未満」 */
export function formatParticipantCount(
  count: number | null | undefined,
  minParticipants: number = ORG_CHALLENGE_MIN_PARTICIPANTS,
): string {
  if (count === null || count === undefined || !Number.isFinite(count)) return `${minParticipants}人未満`;
  return `${count}人`;
}
