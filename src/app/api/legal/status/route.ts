// src/app/api/legal/status/route.ts
// #1442: ログイン中の本人の、利用規約・プライバシーポリシーへの同意の状況と、いま強制中かを返す。
//
//   GET /api/legal/status → 200 LegalConsentStatus (packages/shared/src/legal-consent-api.ts)
//   アプリ (apps/mobile) が起動時・再同意の判定・同意画面の表示 (いまの版と施行日) に使う。
//   Web (Cookie) とアプリ (Authorization: Bearer) が同じ契約で使う。
//
// この API は同意ゲートの許可リスト (LEGAL_CONSENT_EXEMPT_API_PATHS) にある (未同意でも 200)。
// 凍結中のアカウントは middleware が /api/* で 403 にする (この API は FROZEN_ALLOWED_API_PATHS には無い)。
// 環境変数 LEGAL_CONSENT_ENFORCE は lib/legal-consent.ts の isLegalConsentEnforced だけが読む (tests/env-source-scan.test.ts)。
// 生年月日の未入力と、保護者の同意とのつながりの無い 18 歳未満も required になる (gaps の 'birth_date' / 'guardian_consent'。#1173)。
import { NextResponse } from 'next/server';
import { resolveLegalConsentStatus } from '@homegohan/shared';
import { createClient } from '@/lib/supabase/server';
import { isLegalConsentEnforced } from '@/lib/legal-consent';
import { withMinorGuardianStatus } from '@/lib/legal-consent-minor';
import { LegalConsentStatusSchema } from '@/lib/legal-consent-api';
import { internalError } from '@/lib/api/errors';

// 同意の状況は利用者ごとに違い、同意した直後に変わる。キャッシュさせない
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** 同意ゲートが読むのと同じ 3 列 (lib/supabase/middleware.ts の PROFILE_COLUMNS_WITH_LEGAL の末尾 3 列) */
const LEGAL_COLUMNS = 'terms_version_accepted, privacy_version_accepted, birth_date';

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: '認証が必要です', code: 'AUTH_UNAUTHENTICATED' }, { status: 401, headers: NO_STORE });
    }

    // 本人のセッションのクライアントで読む (RLS により自分の行だけが見える)。行が無い (新規登録の直後) ときは null = 未同意
    const { data: profile, error } = await supabase.from('user_profiles').select(LEGAL_COLUMNS).eq('id', user.id).maybeSingle();
    if (error) {
      // 列が無い DB (42703) も含め、読めなければ汎用の 500 (本文に DB の文は出さない)。アプリは「分からない」として止めない
      return internalError('GET /api/legal/status', error, { userId: user.id, table: 'user_profiles' });
    }

    // 18 歳未満のときだけ、保護者の同意とのつながりを DB に聞く (rpc を 1 回。失敗は素通り)
    const gateProfile = await withMinorGuardianStatus(supabase, profile);
    const status = resolveLegalConsentStatus({ accepted: gateProfile, enforced: isLegalConsentEnforced() });
    // 正本の形から外れた応答を返さない (外れていればこちらの不具合なので 500)
    const parsed = LegalConsentStatusSchema.safeParse(status);
    if (!parsed.success) {
      return internalError('GET /api/legal/status', parsed.error, { userId: user.id });
    }
    return NextResponse.json(parsed.data, { status: 200, headers: NO_STORE });
  } catch (error) {
    return internalError('GET /api/legal/status', error);
  }
}
