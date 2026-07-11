/**
 * frozen_at (アカウント凍結) の判定ロジック
 * #1030 [Crit] frozen_at/BAN の enforcement
 *
 * `src/lib/auth/helpers.ts` (requireUser/requireRole) と
 * `lib/supabase/middleware.ts` (ページナビゲーション) の両方から参照される
 * 純粋関数。DB アクセスは行わない (呼び出し側が frozen_at/unban_at を渡す)。
 */

export interface FrozenCheckInput {
  /** user_profiles.frozen_at (NULL = 凍結されていない) */
  frozenAt: string | null | undefined;
  /** user_profiles.unban_at (一時 BAN の解除予定日時。NULL = 無期限 or 凍結なし) */
  unbanAt: string | null | undefined;
}

/**
 * 現時点でアクセスをブロックすべき凍結状態かどうかを判定する。
 *
 * - frozen_at が NULL → false (凍結されていない)
 * - frozen_at が NOT NULL かつ unban_at が NULL → true (無期限 BAN / 凍結)
 * - frozen_at が NOT NULL かつ unban_at が未来 → true (一時 BAN 継続中)
 * - frozen_at が NOT NULL かつ unban_at が過去 → false (一時 BAN 期限切れ、自動解除扱い)
 */
export function isAccountFrozen({ frozenAt, unbanAt }: FrozenCheckInput): boolean {
  if (!frozenAt) return false;
  if (unbanAt && new Date(unbanAt).getTime() <= Date.now()) {
    return false;
  }
  return true;
}
