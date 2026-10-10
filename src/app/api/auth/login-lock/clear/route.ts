/**
 * POST /api/auth/login-lock/clear — パスワードの再設定を済ませたあとで、ログイン失敗のロックを外す (#1165)
 *
 * 設計 docs/design/cross/01-auth-session.md §8: 「ロック中は正しいパスワードでも拒否。メール経由のリセットのみ解除可能」。
 * パスワードの再設定の画面 (src/app/(auth)/auth/reset-password/page.tsx) が、パスワードを更新できた直後
 * (全端末のログアウトの前) に呼ぶ。
 *
 * - 呼べるのは、再設定のメールのリンクから作られたセッション (JWT の amr に recovery がある) だけ。
 *   ふつうのログインのセッションでは外さない (403)。外せるのは、そのセッションのアカウントの登録メールアドレスの記録だけ。
 * - 本文は無い。応答は 200 { ok: true } / 401 (未ログイン) / 403 (再設定のセッションではない) / 500。
 * - 失敗しても、パスワードの再設定そのものは済んでいる。ロックは期限が来れば外れる。
 */
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { clearLoginFailures, type LoginLockRpcClient } from '@/lib/auth/login-lock';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/auth/login-lock/clear';

/** 再設定のメールのリンクから作られたセッションの、JWT の amr の値 (Supabase Auth の決まり) */
const RECOVERY_AMR_METHOD = 'recovery';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/** JWT の amr (認証の方法の記録)。{ method } の配列か、文字列の配列 */
function hasRecoveryAmr(amr: unknown): boolean {
  if (!Array.isArray(amr)) return false;
  return amr.some((entry: unknown) => {
    if (typeof entry === 'string') return entry === RECOVERY_AMR_METHOD;
    if (typeof entry === 'object' && entry !== null && 'method' in entry) {
      return (entry as { method: unknown }).method === RECOVERY_AMR_METHOD;
    }
    return false;
  });
}

export async function POST() {
  const supabase = createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsError ? null : claimsData?.claims ?? null;
  if (!claims) {
    return NextResponse.json({ error: 'ログインが必要です。', code: 'UNAUTHORIZED' }, { status: 401, headers: NO_STORE });
  }
  if (!hasRecoveryAmr(claims.amr)) {
    return NextResponse.json(
      { error: 'パスワードの再設定のあとでだけ使えます。', code: 'FORBIDDEN' },
      { status: 403, headers: NO_STORE },
    );
  }

  // メールアドレスは JWT ではなく、Supabase Auth から引き直した登録アドレスを使う
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const email = userError ? null : userData.user?.email?.trim().toLowerCase() ?? null;
  if (!email) {
    return NextResponse.json({ error: 'ログインが必要です。', code: 'UNAUTHORIZED' }, { status: 401, headers: NO_STORE });
  }

  try {
    const admin = getSupabaseAdmin();
    const lockStore: LoginLockRpcClient = { rpc: (fn, args) => admin.rpc(fn, args) };
    await clearLoginFailures(lockStore, email);
  } catch (error) {
    return internalError(ROUTE_NAME, error, { userId: userData.user?.id });
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
}
