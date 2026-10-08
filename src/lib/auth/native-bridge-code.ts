/**
 * モバイル WebView 認証ブリッジのワンタイムコード (#1036)
 *
 * 旧方式は Supabase の access_token / refresh_token を URL クエリ
 * (GET /auth/native-bridge?access_token=...&refresh_token=...) で WebView に渡していた。
 * URL はサーバ・CDN・プロキシのアクセスログに残るため、有効なリフレッシュトークンがそのまま漏れる。
 * 新方式では URL にワンタイムコードだけを載せ、サーバ側でコードをトークンに交換する。
 *
 *   1. ネイティブ: POST /api/auth/native-bridge/code (Authorization: Bearer <JWT>, body {refresh_token})
 *      -> issueNativeBridgeCode(): 256 bit の乱数コードを作り、sha256(コード) とトークンを
 *         public.native_bridge_codes に保存する (有効 60 秒)
 *   2. WebView: GET /auth/native-bridge?code=...
 *      -> consumeNativeBridgeCode(): DELETE ... RETURNING で 1 回だけ引き換え、setSession で Cookie にする
 *
 * DB にはコード本体を保存しない (sha256 のみ)。表と RPC は service_role 専用のため、
 * ここの関数は getSupabaseAdmin() 経由で呼ぶ。呼び出し側 (API ルート) は、認可を済ませてから使うこと。
 *
 * ログ方針: コード・アクセストークン・リフレッシュトークンはどのログにも出さない
 * (エラーにも値を含めない。db-logger は metadata の *token* キーをマスクするが、そもそも渡さない)。
 */

import { createHash, randomBytes } from 'node:crypto'
import { getSupabaseAdmin } from '@/lib/supabase/server'

/** コードの有効期間 (秒)。DB 側の上限 (発行 RPC は 120 秒、表の CHECK は 5 分) より短く保つ */
export const NATIVE_BRIDGE_CODE_TTL_SECONDS = 60

/**
 * auth-js がセッションを「期限切れ間近」とみなして更新を始める余裕 (秒)。
 * @supabase/auth-js 2.105 の EXPIRY_MARGIN_MS (= 3 × 30 秒)。getSession() / getUser() の内部
 * (__loadSession) は、有効期限までの残りがこれ未満だと refresh_token でトークンを更新 (ローテーション) する。
 */
const AUTH_JS_EXPIRY_MARGIN_SECONDS = 90

/**
 * コード発行時に、アクセストークンの有効期限までに最低限残っていてほしい秒数。
 * Web 側でセッションを作ったあとにトークンが更新 (ローテーション) されると、ネイティブが持つ refresh_token が
 * 使用済みになり、次の更新で再利用検知によりセッションごと失効し得る。コードは発行から最長
 * NATIVE_BRIDGE_CODE_TTL_SECONDS 後に使われるので、その時点でも auth-js の余裕 (90 秒) が残るよう、
 * 「コードの有効期間 + 90 秒」を要求する。ネイティブ側は残りがこれ未満なら先に refreshSession() してから発行を頼む。
 */
export const MIN_ACCESS_TOKEN_REMAINING_SECONDS = NATIVE_BRIDGE_CODE_TTL_SECONDS + AUTH_JS_EXPIRY_MARGIN_SECONDS

/** refresh_token の最大長 (Supabase のリフレッシュトークンは短い不透明な文字列) */
export const MAX_REFRESH_TOKEN_LENGTH = 1024

/** Authorization ヘッダで受け付ける JWT の最大長 (異常に長い値で Auth API を叩かせない) */
const MAX_BEARER_TOKEN_LENGTH = 4096

/** base64url(32 バイト) は 43 文字 */
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** 発行 / 消費 RPC の失敗。値 (コード・トークン) はメッセージに含めない */
export class NativeBridgeCodeError extends Error {
  constructor(
    message: string,
    public readonly pgCode?: string,
  ) {
    super(message)
    this.name = 'NativeBridgeCodeError'
  }
}

/** 256 bit の乱数を base64url にしたワンタイムコード (43 文字) を作る */
export function generateNativeBridgeCode(): string {
  return randomBytes(32).toString('base64url')
}

/** コードの sha256 (小文字 16 進 64 文字)。DB にはこれだけを保存する */
export function hashNativeBridgeCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

/** コードとして形式が正しいか。不正な値は DB に問い合わせずに無効として扱う */
export function isWellFormedNativeBridgeCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_PATTERN.test(value)
}

/**
 * Authorization ヘッダから Bearer トークンを取り出す。形式が違う・空・長すぎる場合は null。
 * (Cookie だけの認証を受け付けないため、API ルートはこの結果が無ければ 401 にする)
 */
export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header)
  if (!match) return null
  const token = match[1]
  return token.length <= MAX_BEARER_TOKEN_LENGTH ? token : null
}

/**
 * JWT の exp (UNIX 秒) を返す。署名の検証はしない (呼び出し側が先に Auth API で検証済みの前提)。
 * 形式が壊れている・exp が無い場合は null。
 */
export function getJwtExpiresAt(jwt: string): number | null {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown } | null
    const exp = payload?.exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null
  } catch {
    return null
  }
}

export interface IssueNativeBridgeCodeInput {
  userId: string
  accessToken: string
  refreshToken: string
}

/**
 * ワンタイムコードを発行する。コード本体を返し、DB には sha256 とトークンを保存する。
 * 呼び出し側は、userId が accessToken の持ち主であること (Auth API で検証済み) を保証すること。
 *
 * @throws NativeBridgeCodeError RPC の失敗 (pgCode に SQLSTATE を持つ)
 */
export async function issueNativeBridgeCode(input: IssueNativeBridgeCodeInput): Promise<string> {
  const code = generateNativeBridgeCode()
  const { error } = await getSupabaseAdmin().rpc('issue_native_bridge_code', {
    p_code_hash: hashNativeBridgeCode(code),
    p_user_id: input.userId,
    p_access_token: input.accessToken,
    p_refresh_token: input.refreshToken,
    p_ttl_seconds: NATIVE_BRIDGE_CODE_TTL_SECONDS,
  })
  if (error) {
    throw new NativeBridgeCodeError('issue_native_bridge_code failed', error.code)
  }
  return code
}

export interface ConsumedNativeBridgeCode {
  userId: string
  accessToken: string
  refreshToken: string
}

/**
 * コードを 1 回だけ引き換える。形式が不正・存在しない・期限切れ・使用済みなら null。
 * 形式が不正なコードは DB に問い合わせない。
 *
 * @throws NativeBridgeCodeError RPC の失敗 (コードの状態は不明。呼び出し側は無効扱いにしてよい)
 */
export async function consumeNativeBridgeCode(code: string): Promise<ConsumedNativeBridgeCode | null> {
  if (!isWellFormedNativeBridgeCode(code)) return null

  const { data, error } = await getSupabaseAdmin().rpc('consume_native_bridge_code', {
    p_code_hash: hashNativeBridgeCode(code),
  })
  if (error) {
    throw new NativeBridgeCodeError('consume_native_bridge_code failed', error.code)
  }

  // RETURNS TABLE は PostgREST では配列で返る (0 行 = 無効)。念のため単一オブジェクトも受け付ける
  const row = (Array.isArray(data) ? data[0] : data) as
    | { user_id?: unknown; access_token?: unknown; refresh_token?: unknown }
    | null
    | undefined
  if (!row) return null

  if (
    typeof row.user_id !== 'string' ||
    typeof row.access_token !== 'string' ||
    typeof row.refresh_token !== 'string'
  ) {
    throw new NativeBridgeCodeError('consume_native_bridge_code returned an unexpected row')
  }

  return { userId: row.user_id, accessToken: row.access_token, refreshToken: row.refresh_token }
}

// ─────────────────────────────────────────────────────────────────────────────
// 旧方式 (トークンを URL クエリで渡す GET) の受け付け期限
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 旧方式の受け付けを終える日時。この時刻以降は 426 を返し、セッションを作らない。
 *
 * オーナー判断 (2026-10-07、#1036): 2026-12-31 に止める。それまでは旧ビルドのアプリも動く。
 * 期限より早く閉じたいときは、コードの変更ではなく環境変数 NATIVE_BRIDGE_LEGACY_GET=off を使う
 * (Vercel の環境変数の変更は再デプロイ後に効く)。止める前に app_logs の 'legacy token-in-query bridge used' の件数を見る。
 */
export const LEGACY_SUNSET_AT = '2026-12-31T00:00:00+09:00'

/**
 * 旧方式 (GET /auth/native-bridge?access_token=...&refresh_token=...) を今受け付けてよいか。
 * - 環境変数 NATIVE_BRIDGE_LEGACY_GET が 'off' なら受け付けない (大文字小文字・前後の空白は無視)
 * - LEGACY_SUNSET_AT 以降は受け付けない。日時が解釈できない場合も安全側 (受け付けない) に倒す
 */
export function isLegacyNativeBridgeAllowed(now: number = Date.now()): boolean {
  if ((process.env.NATIVE_BRIDGE_LEGACY_GET ?? '').trim().toLowerCase() === 'off') return false
  const sunsetAt = Date.parse(LEGACY_SUNSET_AT)
  if (Number.isNaN(sunsetAt)) return false
  return now < sunsetAt
}
