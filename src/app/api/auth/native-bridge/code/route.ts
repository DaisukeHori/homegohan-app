// src/app/api/auth/native-bridge/code/route.ts
// #1036: モバイル WebView 認証ブリッジのワンタイムコード発行
//
// ネイティブアプリが WebView を認証済みにするため、アクセストークン / リフレッシュトークンを URL に載せる代わりに、
// ここで 60 秒・1 回限りのコードをもらい、WebView は GET /auth/native-bridge?code=... だけを開く。
//
// 認可:
//   - Authorization: Bearer <JWT> を必須にする。Cookie だけの認証は受け付けない
//     (Cookie 認証を許すと、他サイトからのリクエストでコードを発行させる CSRF の面ができる)。
//   - requireUser() / createClient().auth.getUser() は使わない。引数なしの getUser() は Authorization ヘッダより
//     Cookie のセッションを優先するため、WebView と共有された古い Cookie が混ざるとアカウント切り替え直後に
//     誤った 401 になり得る。ヘッダの JWT を明示して getUser(jwt) で検証する。
//   - 凍結中のアカウントには発行しない (middleware も /api/* で凍結を弾くが、ここでも確認する)。
//   - アクセストークンの有効期限までの残りが短いときは発行しない。コードの引き換えで期限切れだと
//     setSession がリフレッシュトークンをローテーションし、ネイティブ側の保持分が使用済みになってしまう。
//
// ログ: リクエスト body・コード・トークンは一切ログに出さない。
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger, generateRequestId } from '@/lib/db-logger'
import { isAccountFrozen } from '@/lib/auth/frozen'
import {
  MAX_REFRESH_TOKEN_LENGTH,
  MIN_ACCESS_TOKEN_REMAINING_SECONDS,
  NATIVE_BRIDGE_CODE_TTL_SECONDS,
  NativeBridgeCodeError,
  extractBearerToken,
  getJwtExpiresAt,
  issueNativeBridgeCode,
} from '@/lib/auth/native-bridge-code'

/** body の最大文字数 (refresh_token は MAX_REFRESH_TOKEN_LENGTH 以内。余裕を見ても数 KB で足りる) */
const MAX_BODY_CHARS = 4096

const BodySchema = z.object({
  refresh_token: z.string().min(1).max(MAX_REFRESH_TOKEN_LENGTH),
})

/** X-App-Platform / X-App-Version に許す形式 (ログに載せるので、記号や長い値は捨てる) */
const APP_META_PATTERN = /^[A-Za-z0-9._+-]{1,32}$/

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } })
}

const unauthenticated = () => errorResponse(401, 'AUTH_UNAUTHENTICATED', '認証が必要です')
const badRequest = () => errorResponse(400, 'NATIVE_BRIDGE_BAD_REQUEST', '入力値が不正です')
const unavailable = () =>
  errorResponse(503, 'NATIVE_BRIDGE_UNAVAILABLE', '一時的に利用できません。しばらくしてからもう一度お試しください')

function appMeta(value: string | null): string | undefined {
  return value && APP_META_PATTERN.test(value) ? value : undefined
}

export async function POST(request: Request) {
  const logger = createLogger('POST /api/auth/native-bridge/code', generateRequestId())

  // 1. Bearer 必須 (Cookie だけの認証は受け付けない)
  const jwt = extractBearerToken(request.headers.get('authorization'))
  if (!jwt) return unauthenticated()

  // 2. body: { refresh_token: string (1〜1024 文字) }。巨大な body は読み込んだ後でも捨てる
  let body: unknown
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY_CHARS) return badRequest()
    body = JSON.parse(raw)
  } catch {
    return badRequest()
  }
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) return badRequest()
  const refreshToken = parsed.data.refresh_token

  try {
    const admin = getSupabaseAdmin()

    // 3. Authorization ヘッダの JWT を Auth API で検証する (Cookie は見ない)
    const {
      data: { user },
      error: authError,
    } = await admin.auth.getUser(jwt)
    if (authError || !user) {
      // Auth 基盤の障害 (ネットワーク断・5xx) は「トークンが不正」ではないので 503 にする
      const transient =
        authError?.name === 'AuthRetryableFetchError' ||
        (typeof authError?.status === 'number' && authError.status >= 500)
      return transient ? unavailable() : unauthenticated()
    }

    // 4. 有効期限までの残りが短いトークンには発行しない (ネイティブ側で更新してからやり直す)
    const expiresAt = getJwtExpiresAt(jwt)
    if (expiresAt === null) return unauthenticated()
    if (expiresAt - Date.now() / 1000 < MIN_ACCESS_TOKEN_REMAINING_SECONDS) {
      return errorResponse(
        401,
        'AUTH_TOKEN_EXPIRING',
        'アクセストークンの有効期限が近いため、更新してからもう一度お試しください',
      )
    }

    // 5. 凍結中のアカウントには発行しない。確認できないときは安全側 (発行しない) に倒す
    const { data: profile, error: profileError } = await admin
      .from('user_profiles')
      .select('frozen_at, unban_at')
      .eq('id', user.id)
      .maybeSingle()
    if (profileError) {
      // DB の生のエラーオブジェクトはログに渡さず、SQLSTATE だけを残す
      logger
        .withUser(user.id)
        .error('user_profiles lookup failed', new Error('user_profiles lookup failed'), { pg_code: profileError.code })
      return unavailable()
    }
    if (isAccountFrozen({ frozenAt: profile?.frozen_at ?? null, unbanAt: profile?.unban_at ?? null })) {
      return errorResponse(403, 'AUTH_ACCOUNT_FROZEN', 'アカウントが凍結されています')
    }

    // 6. 発行 (DB には sha256 だけを保存する)
    let code: string
    try {
      code = await issueNativeBridgeCode({ userId: user.id, accessToken: jwt, refreshToken })
    } catch (error) {
      logger.withUser(user.id).error('issue_native_bridge_code failed', error, {
        pg_code: error instanceof NativeBridgeCodeError ? error.pgCode : undefined,
      })
      return unavailable()
    }

    // アプリのバージョンを知る手がかり (旧方式をいつ閉じてよいかの判断材料)。ヘッダが無ければ記録しない
    const platform = appMeta(request.headers.get('x-app-platform'))
    const appVersion = appMeta(request.headers.get('x-app-version'))
    if (platform || appVersion) {
      logger.withUser(user.id).info('native bridge code issued', { platform, app_version: appVersion })
    }

    return NextResponse.json(
      { code, expires_in: NATIVE_BRIDGE_CODE_TTL_SECONDS },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    // getSupabaseAdmin() の環境変数欠落など。body・トークンは渡さない
    logger.error('native bridge code issuance failed unexpectedly', error)
    return unavailable()
  }
}
