/**
 * GET /api/feature-flags — クライアント (Web・モバイル) 向けの機能フラグ (#1148)
 *
 * 画面が「今、AI 相談は使えるか」「メンテナンス中か」を知るための窓口。ログインしていなくても答える
 * (メンテナンス中かどうかは、ログイン前の画面でも要るため)。
 *
 * 返すのは CLIENT_FEATURE_FLAG_KEYS (src/lib/feature-flags.ts) に載せたフラグだけ。運営が作った別のフラグの名前を
 * 一般のユーザーに見せない。値はログイン中のユーザーにとっての ON/OFF (段階公開があれば、そのユーザーでの判定)。
 *   ai_chat_enabled   false のとき AI 相談の API は 503 を返す (緊急停止中)。通常は true
 *   maintenance_mode  true のとき、このユーザーにはメンテナンス中として見せる。運営 (admin / super_admin) は
 *                     メンテナンス中でも使えるので、フラグが ON でも false で返す
 *
 * フラグの値はサーバーのメモリに最大 30 秒覚えるため、運営画面で切り替えてから反映まで最大 30 秒かかる。
 * フラグの行が無い・読み出しに失敗したときは、止めない側の値 (ai_chat_enabled = true / maintenance_mode = false) を返す。
 * ミドルウェアは、メンテナンス中でもこの API を止めない (isMaintenanceExemptPath)。
 *
 * レスポンス: { data: { flags: { ai_chat_enabled: boolean, maintenance_mode: boolean } } }
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { CLIENT_FEATURE_FLAG_KEYS, isFeatureEnabled, type FeatureFlagContext } from '@/lib/feature-flags';
import { isOperatorRoles } from '@/lib/maintenance-mode';

export const dynamic = 'force-dynamic';

/** ログイン中のユーザー本人の属性 (段階公開や条件の判定に使う)。本人の行しか読まない (RLS) */
async function loadOwnContext(): Promise<{ userId?: string; context?: FeatureFlagContext }> {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return {};

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('roles, organization_id, plan_key_cached, created_at')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile) return { userId: user.id };
    return {
      userId: user.id,
      context: {
        roles: Array.isArray(profile.roles) ? profile.roles : [],
        organizationId: profile.organization_id ?? null,
        // plan_key_cached が空のユーザーは無料プランとして扱う (src/lib/feature-flags.ts と同じ)
        planKey: profile.plan_key_cached ?? 'free',
        accountCreatedAt: profile.created_at ?? null,
      },
    };
  } catch {
    // 認証基盤の一時障害は、未ログイン扱いで答える (この API は、止めない側に倒す)
    return {};
  }
}

export async function GET() {
  const { userId, context } = await loadOwnContext();

  const entries = await Promise.all(
    CLIENT_FEATURE_FLAG_KEYS.map(async (key) => [key, await isFeatureEnabled(key, userId, { context })] as const),
  );
  const flags = Object.fromEntries(entries) as Record<(typeof CLIENT_FEATURE_FLAG_KEYS)[number], boolean>;

  // 運営は、メンテナンス中でも使える。クライアントがメンテナンス中の画面を出さないよう、false にする
  if (isOperatorRoles(context?.roles)) {
    flags.maintenance_mode = false;
  }

  return NextResponse.json(
    { data: { flags } },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
