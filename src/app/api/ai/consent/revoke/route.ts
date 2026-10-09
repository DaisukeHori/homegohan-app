import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { getAiConsentStatus, revokeAiConsent } from '@/lib/ai/consent';

/**
 * T15 (#1154) 外国の AI 事業者への提供の同意: 撤回
 *
 * POST /api/ai/consent/revoke  ログイン中のユーザー本人の有効な同意を、すべて撤回する
 *
 * 行は消さず、revoked_at を入れる (監査のために残す。DELETE は RLS が拒否する)。service role で書く。
 * 対象は常に認証で確定した本人。リクエストの body / URL から ID を受け取らない。本文は要らない。
 * 有効な同意が無いときは何も変えず、成功 (revokedCount = 0) を返す。
 * 撤回は利用者の権利なので、回数制限はかけない (行を増やさず、既存の行に revoked_at を入れるだけ)。
 *
 * 【撤回したら AI へ送らない】撤回のあとは、AI へ送る各経路が送る手前で 403 AI_CONSENT_REQUIRED を返して止める
 * (判定は src/lib/ai/consent-guard.ts / supabase/functions/_shared/ai-consent-guard.ts)。もう一度使うには、あらためて同意が要る。
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST() {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const logger = createLogger('POST /api/ai/consent/revoke', generateRequestId()).withUser(user.id);

  try {
    const { revokedCount } = await revokeAiConsent(user.id);
    const status = await getAiConsentStatus(user.id, supabase);
    logger.info('AI consent revoked', { revokedCount });
    return NextResponse.json({ ...status, revokedCount }, { headers: NO_STORE });
  } catch (error) {
    logger.error('AI consent revoke failed', error);
    return NextResponse.json(
      { error: '同意を撤回できませんでした。時間をおいて再度お試しください。', code: 'AI_CONSENT_REVOKE_FAILED' },
      { status: 500, headers: NO_STORE },
    );
  }
}
