/** 凍結 (BAN) 中も通す課金の route の認証 (billing/01 §9.8) */
import { AuthError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';

/** 凍結中も通す課金の route が受け取る利用者 (route は id だけを使う) */
export interface BillingRouteUser {
  id: string;
  email: string | null;
}

/**
 * 凍結 (BAN) 中の利用者も通す課金の route の認証 (billing/01 §9.8)。使うのは GET /api/billing/subscription・
 * POST /api/billing/subscription/cancel・POST /api/billing/portal の 3 本だけ (src/lib/auth/frozen.ts の FROZEN_ALLOWED_API_PATHS に載る課金のパス。
 * どの route が使うかはテスト 115 が見張る)。ログインのセッションだけを確かめ、凍結 (user_profiles.frozen_at) は見ない。
 * requireUser() (src/lib/auth/helpers.ts) は凍結中に ForbiddenError('AUTH_ACCOUNT_FROZEN') を投げるので、この 3 本では使わない
 */
export async function requireUserAllowingFrozen(): Promise<BillingRouteUser> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new AuthError('AUTH_UNAUTHENTICATED');
  return { id: user.id, email: user.email ?? null };
}
