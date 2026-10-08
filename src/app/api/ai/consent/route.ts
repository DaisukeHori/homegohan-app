import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import {
  AI_CONSENT_PROVIDERS,
  AI_CONSENT_VERSION,
  extractClientIp,
  extractUserAgent,
  getAiConsentStatus,
  grantAiConsent,
} from '@/lib/ai/consent';

/**
 * T15 (#1154) 外国の AI 事業者への提供の同意: 状況の確認と、同意の記録
 *
 * GET  /api/ai/consent  ログイン中のユーザー本人の同意の状況を返す
 * POST /api/ai/consent  全事業者について、現行の文面の版への同意を記録する
 *
 * 同意は service role で書く (クライアントから external_data_consents への INSERT はできない)。
 * IP アドレス (x-forwarded-for の先頭の値) と User-Agent は、クライアントの申告ではなく、このリクエストのヘッダーから取る。
 * 対象は常に認証で確定した本人。リクエストの body / URL から ID を受け取らない。
 * Web (Cookie 認証) とモバイルの WebView / アプリ (Authorization: Bearer) が同じ契約で使う。
 *
 * 【AI への送信は止めない】同意の有無で AI の呼び出しを止める処理は、この PR には無い (強制は T18)。
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const logger = createLogger('GET /api/ai/consent', generateRequestId()).withUser(user.id);

  try {
    // 本人のセッションのクライアントで読む (RLS により自分の行だけが見える)
    const status = await getAiConsentStatus(user.id, supabase);
    return NextResponse.json(status, { headers: NO_STORE });
  } catch (error) {
    logger.error('AI consent status failed', error);
    return NextResponse.json(
      { error: '同意の状況を取得できませんでした。時間をおいて再度お試しください。', code: 'AI_CONSENT_STATUS_FAILED' },
      { status: 500, headers: NO_STORE },
    );
  }
}

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const logger = createLogger('POST /api/ai/consent', generateRequestId()).withUser(user.id);

  // 同意と撤回を繰り返して行を増やされないようにする。判定できないとき (Redis 障害) は通さない (fail-close)
  try {
    const rateLimit = await checkRateLimit(user.id, 'ai-consent');
    if (!rateLimit.success) {
      logger.warn('AI consent rate limited', { reset: rateLimit.reset });
      return rateLimitExceededResponse(rateLimit);
    }
  } catch (error) {
    logger.error('AI consent rate limit check failed', error);
    return NextResponse.json(
      { error: '同意を記録できませんでした。時間をおいて再度お試しください。', code: 'AI_CONSENT_UNAVAILABLE' },
      { status: 503, headers: NO_STORE },
    );
  }

  // 画面に出した文面の版を受け取る。別のサイトからの本文なしの送信で同意を記録されないこと、
  // 同意が「画面で見せた文面」に対するものであることを確かめるため、必須にしている
  const body = (await request.json().catch(() => null)) as { version?: unknown } | null;
  if (!body || typeof body.version !== 'string' || body.version.length === 0) {
    return NextResponse.json(
      { error: '同意する文面の版が指定されていません。', code: 'AI_CONSENT_BAD_REQUEST' },
      { status: 400, headers: NO_STORE },
    );
  }
  if (body.version !== AI_CONSENT_VERSION) {
    // 同意画面を開いたあとに文面が更新された。更新後の文面を見てもらってから同意を取り直す
    return NextResponse.json(
      {
        error: '同意の文面が更新されました。画面を開き直して、あらためてご確認ください。',
        code: 'AI_CONSENT_VERSION_MISMATCH',
        currentVersion: AI_CONSENT_VERSION,
      },
      { status: 409, headers: NO_STORE },
    );
  }

  try {
    const status = await grantAiConsent({
      userId: user.id,
      ipAddress: extractClientIp(request.headers),
      userAgent: extractUserAgent(request.headers),
    });
    logger.info('AI consent granted', {
      version: AI_CONSENT_VERSION,
      providers: [...AI_CONSENT_PROVIDERS],
      consented: status.consented,
    });
    return NextResponse.json(status, { headers: NO_STORE });
  } catch (error) {
    logger.error('AI consent grant failed', error);
    return NextResponse.json(
      { error: '同意を記録できませんでした。時間をおいて再度お試しください。', code: 'AI_CONSENT_GRANT_FAILED' },
      { status: 500, headers: NO_STORE },
    );
  }
}
