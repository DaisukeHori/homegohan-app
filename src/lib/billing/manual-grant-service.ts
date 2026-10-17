// 手動のプラン付与のユースケース (billing/02 §8.3)。route はこれだけを呼ぶ。
// DB は repository (service_role)。Stripe は呼ばない。監査は route が書く (recordAdminAudit は request を要るため)。
import { jstDayRangeTimestamps } from '@/lib/jst-day-ranges';
import {
  MANUAL_GRANT_RPC_TO_API_CODE,
  ManualGrantError,
  type ManualPlanGrantResult,
  type ManualPlanRevokeResult,
  type ManualPlanView,
} from '@/lib/billing/manual-grant';
import { ManualGrantRpcError, type ManualGrantRepository } from '@/lib/billing/manual-grant-repository';

export interface ManualGrantDeps {
  repository: ManualGrantRepository;
}

/** 有効期限の日 (JST の暦日) → その日の終わり = 翌日の JST 0 時 (timestamptz の ISO)。「2026-12-31 まで」= 2026-12-31T15:00:00.000Z */
export function expiresAtOf(expiresOn: string): string {
  return jstDayRangeTimestamps(expiresOn, expiresOn).toTimestampExclusive;
}

function rethrowRpcError(error: unknown): never {
  if (error instanceof ManualGrantRpcError) throw new ManualGrantError(MANUAL_GRANT_RPC_TO_API_CODE[error.code]);
  throw error;
}

/** GET の中身。利用者が無ければ NOT_FOUND */
export async function getManualPlanView(deps: ManualGrantDeps, userId: string): Promise<ManualPlanView> {
  if (!(await deps.repository.userExists(userId))) throw new ManualGrantError('NOT_FOUND');
  const [current, plans, history] = await Promise.all([
    deps.repository.findLiveSubscription(userId),
    deps.repository.listGrantablePlans(),
    deps.repository.listHistory(userId),
  ]);
  return { current, plans, history };
}

export interface GrantManualPlanInput {
  /** 対象の利用者 (route が normalizeUuid した id) */
  userId: string;
  /**
   * 実行者 (route が normalizeUuid した id)。同じなら OP_SELF_MODIFY。
   * route は本文の検証の前に同じ判定で 403 を返している (§9.0 の 4) ので、ここは二重の守り (route を経ずに呼ばれたとき)
   */
  actorId: string;
  planKey: string;
  /** JST の暦日 (スキーマが今日より後を確かめ済み)。null = 期限なし */
  expiresOn: string | null;
}

/** 付与。業務エラーは ManualGrantError (route が §12.1 の HTTP に写す)。それ以外の例外は 500 */
export async function grantManualPlan(deps: ManualGrantDeps, input: GrantManualPlanInput): Promise<ManualPlanGrantResult> {
  // 二重の守り (route の §9.0 の 4 と同じ判定)。repository に触れる前に断る
  if (input.userId === input.actorId) throw new ManualGrantError('OP_SELF_MODIFY');
  if (!(await deps.repository.userExists(input.userId))) throw new ManualGrantError('NOT_FOUND');
  const expiresAt = input.expiresOn === null ? null : expiresAtOf(input.expiresOn);
  try {
    return await deps.repository.grant({ userId: input.userId, planKey: input.planKey, expiresAt });
  } catch (error) {
    return rethrowRpcError(error);
  }
}

export interface RevokeManualPlanInput {
  /** 対象の利用者 (route が normalizeUuid した id) */
  userId: string;
  /** 実行者 (route が normalizeUuid した id)。同じなら OP_SELF_MODIFY (GrantManualPlanInput.actorId と同じく二重の守り) */
  actorId: string;
}

/** 取り消し。live な M 行が無ければ OP_NO_MANUAL_SUBSCRIPTION */
export async function revokeManualPlan(deps: ManualGrantDeps, input: RevokeManualPlanInput): Promise<ManualPlanRevokeResult> {
  // 二重の守り (route の §9.0 の 4 と同じ判定)。repository に触れる前に断る
  if (input.userId === input.actorId) throw new ManualGrantError('OP_SELF_MODIFY');
  if (!(await deps.repository.userExists(input.userId))) throw new ManualGrantError('NOT_FOUND');
  try {
    return await deps.repository.revoke(input.userId);
  } catch (error) {
    return rethrowRpcError(error);
  }
}
