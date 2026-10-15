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

/** 退会 (アカウントの即時削除) の API。凍結中でも呼べる (#1445) */
export const ACCOUNT_DELETE_API_PATH = '/api/account/delete';
/** 個人データの書き出し (JSON) の API。凍結中でも呼べる (#1445) */
export const ACCOUNT_EXPORT_API_PATH = '/api/account/export';
/** 有料プランの契約の要約 (GET)。凍結中でも呼べる (billing/01 §9.8: /frozen/billing が、解約できる契約か・解約の予約の日付を読む) */
export const BILLING_SUBSCRIPTION_API_PATH = '/api/billing/subscription';
/** 有料プランの解約の予約 (POST。期間末に解約)。凍結中でも呼べる (billing/01 §9.8) */
export const BILLING_CANCEL_API_PATH = '/api/billing/subscription/cancel';
/** Stripe の Billing Portal を開く (POST。支払い方法の更新・請求書の履歴・Portal での解約)。凍結中でも呼べる (billing/01 §9.8) */
export const BILLING_PORTAL_API_PATH = '/api/billing/portal';

/**
 * #1445: 凍結 (BAN) 中の利用者でも呼べる API のパス (完全一致)。
 *
 * #1445 のオーナーの選択 (2026-10-12): 「凍結 (BAN) 中の利用者も、退会とデータの書き出しをできるようにする (凍結の画面から行ける)」。
 * middleware (lib/supabase/middleware.ts) は凍結中の利用者の /api 呼び出しを 403 AUTH_ACCOUNT_FROZEN で止めるが、
 * ここに挙げたパスだけは止めない。どちらの route も本人のセッションの利用者だけを対象にし、本人以外の ID を受け取らない。
 * 退会の確認は本文の confirm で行い、書き出しは 1 回の GET で完結するので、確認や進捗のための別の API は無い。
 *
 * 足すのは「本人がサービスから離れるための操作」だけにする (凍結の趣旨 = サービスの利用を止める、を崩さないため)。
 * 一覧は tests (lib/supabase/__tests__/middleware-frozen-allowed-api.test.ts) で固定している。
 *
 * billing/01 §9.8: 有料プランの解約の予約と、その前提の 2 つ (契約の要約の読み取り・Billing Portal) も足す。
 * 凍結は契約も Stripe の課金も止めないので、ここで止めると凍結中の利用者は退会のほかに課金を止められない
 * (特定商取引法の最終確認画面の「解約予告期間 (いつでも)」に反する)。解約の取り消し (resume)・購入 (checkout・checkout/preview・checkout/sync) は
 * 足さない (サービスの利用を続ける・始める操作のため)。どの route が凍結を見ない認証 (requireUserAllowingFrozen) を使うかは tests/api/billing-routes.test.ts が見張る
 */
export const FROZEN_ALLOWED_API_PATHS: readonly string[] = Object.freeze([
  ACCOUNT_DELETE_API_PATH,
  ACCOUNT_EXPORT_API_PATH,
  BILLING_SUBSCRIPTION_API_PATH,
  BILLING_CANCEL_API_PATH,
  BILLING_PORTAL_API_PATH,
]);

/**
 * 凍結中の利用者でも呼べる API のパスか (#1445)。完全一致で判定する
 * (前方一致にすると /api/account/delete-xxx のような、後から足した別の API まで凍結中に通ってしまうため)。
 */
export function isFrozenAllowedApiPath(pathname: string): boolean {
  return FROZEN_ALLOWED_API_PATHS.includes(pathname);
}
