import { FORBIDDEN_REASON_MESSAGES } from '@/lib/api/forbidden-reason-messages';

/**
 * 管理 API の失敗応答 (JSON の本文) から、画面に出すメッセージを取り出す。
 * 運営コンソールのお知らせ管理・組織管理の画面で共通に使う。
 *
 * API によって失敗の本文の形が違う。
 *   - お知らせ API (/api/announcements)                : { error: '<日本語の固定の文>' } (例: TITLE_AND_CONTENT_REQUIRED_MESSAGE の 'タイトルと本文を入力してください')
 *   - 管理系 API (/api/admin/organizations など)        : { error: { code: 'OWNER_ALREADY_IN_ORG', message: '…' } }
 * どちらでも、文字列のメッセージがあればそれを返す。無ければ null を返す (呼び出し側が汎用の文言を出す)。
 */
export function extractApiErrorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;

  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') {
    return error.trim() === '' ? null : error;
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return null;
}

/**
 * 管理系 API の失敗応答 ({ error: { code, message } }) から、エラーの code を取り出す。
 * 画面が code で動きを変える (例: 組織のプランの変更で 409 CONFLICT_STALE_DATA なら一覧を読み直す) ときに使う。
 * code が文字列で無い・空・本文の形が違う (お知らせ API の { error: '文字列' } など) ときは null。
 */
export function extractApiErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;

  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() !== '' ? code : null;
}

/**
 * 読んでから書くまでに別の運営が先に変えていた (条件つきの更新が 0 行で、送った変更が入っていない) ときの、エラーの code。
 * 管理系 API はこのとき書かずに 409 で返す (cross/04 §4.2。問い合わせの更新・AI の 1 日の上限の保存・組織のプランの変更・リードのステージの変更など)
 */
export const STALE_DATA_ERROR_CODE = 'CONFLICT_STALE_DATA';

/** STALE_DATA_ERROR_CODE を返すときの HTTP ステータス (409 Conflict) */
export const STALE_DATA_HTTP_STATUS = 409;

/**
 * 失敗の応答が「画面の表示が古い」(409 CONFLICT_STALE_DATA) か。
 * 画面はこのとき文を出すだけでなく、表示を読み直す (運営が手で読み直さなくてよいように。#1917)。
 * 同じ 409 でも別の code (例: AI の上限の PLAN_READ_ONLY) は false。
 */
export function isStaleDataConflict(status: number, body: unknown): boolean {
  return status === STALE_DATA_HTTP_STATUS && extractApiErrorCode(body) === STALE_DATA_ERROR_CODE;
}

/**
 * 状態の変更 (クーポンの一時停止・再開、機能パッケージの廃止など) の失敗の応答が、画面の status が古いことを示す 409 か (#2064)。
 * 409 CONFLICT_STALE_DATA (読んでから書くまでに別の操作が状態を変えた) と、その API の遷移表に無い変更の code
 * (invalidTransitionCode。例: OP_COUPON_INVALID_TRANSITION) の 2 つ。画面のボタンは遷移表にある変更しか送らないので、
 * 遷移表に無いと断られたのは、画面を開いたあとに別の操作で状態が変わっていたとき。画面はこのとき行を読み直す。
 * 同じ 409 でも別の code は false (API の文を出すだけ)
 */
export function isStatusChangeConflict(status: number, body: unknown, invalidTransitionCode: string): boolean {
  if (status !== STALE_DATA_HTTP_STATUS) return false;
  const code = extractApiErrorCode(body);
  return code === STALE_DATA_ERROR_CODE || code === invalidTransitionCode;
}

/**
 * 401 (ログインが切れた) の画面の固定の文 (#2086 V4)。読み込み直しても変わらないので、運営の画面の読み直しはこの文を出し「再試行」を出さない。
 * 手動のプラン付与の AUTH_UNAUTHENTICATED の文 (src/lib/billing/manual-grant.ts の MANUAL_GRANT_CLIENT_MESSAGES) と同じ文
 */
export const UNAUTHENTICATED_SCREEN_MESSAGE = 'ログインし直してください';

/** 403 の画面の固定の文の既定 (運営の route の 403 OP_PERMISSION_DENIED の、ロールが足りないときの文と同じ) */
export const FORBIDDEN_SCREEN_MESSAGE = '権限がありません';

/**
 * 403 の応答の本文から、画面に出す文を決める (#1917)。
 * 本文の文が理由の文 (二段階認証の確認・登録が要る・凍結。src/lib/api/forbidden-reason-messages.ts) なら、その文をそのまま出す。
 * それ以外 (ロールが足りない・本文が読めない・形が違う) は画面の固定の文 (fallback) を出す。
 * 運営の route は、ゲート (requireRole) の後でセッションの状態が変わったとき二段階認証の文を 403 に入れる (#2014) ので、
 * 画面が 403 を固定の「権限がありません」で上書きすると、二段階認証が要るのに権限が無いように見える。
 * 理由の文だけを通すのは、画面ごとの固定の文 (「この画面を見る権限がありません (運営最上位のみ)」など) を残し、
 * 理由でない文 (古い route の英語の文など) を画面に出さないため
 */
export function forbiddenMessageForScreen(body: unknown, fallback: string = FORBIDDEN_SCREEN_MESSAGE): string {
  const message = extractApiErrorMessage(body);
  return message !== null && FORBIDDEN_REASON_MESSAGES.has(message) ? message : fallback;
}

/** 403 の応答 (本文をまだ読んでいない Response) から、画面に出す文を決める。本文が JSON として読めなければ fallback */
export async function forbiddenMessageOfResponse(res: Response, fallback: string = FORBIDDEN_SCREEN_MESSAGE): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  return forbiddenMessageForScreen(body, fallback);
}

/** 401 (Unauthorized。ログインが切れた) の HTTP ステータス */
const HTTP_UNAUTHORIZED_STATUS = 401;

/** 403 (Forbidden) の HTTP ステータス */
const HTTP_FORBIDDEN_STATUS = 403;

/**
 * 運営の画面の操作 (状態の変更・メモの追加など) が失敗の応答で断られたときに、画面に出す文。
 * 「<操作の名前>（<理由>）」の形にする。理由は次の順に決める。
 *   - 401: 「ログインし直してください」(UNAUTHENTICATED_SCREEN_MESSAGE。本文の「認証が必要です」は出さない。#2112 Z4)
 *   - 403: forbiddenMessageForScreen (理由の文 (二段階認証の確認・登録が要る・凍結) はそのまま、それ以外は「権限がありません」)
 *   - 本文の文 (extractApiErrorMessage。{ error: '…' } と { error: { message } } のどちらでも)
 *   - 本文が読めない (JSON でない・形が違う): HTTP ステータス
 * 失敗の応答を黙って捨てないために使う (運営は操作が効いたか分からなくなるため)
 */
export function operationFailureMessage(summary: string, status: number, body: unknown): string {
  if (status === HTTP_UNAUTHORIZED_STATUS) return `${summary}（${UNAUTHENTICATED_SCREEN_MESSAGE}）`;
  if (status === HTTP_FORBIDDEN_STATUS) return `${summary}（${forbiddenMessageForScreen(body)}）`;
  const message = extractApiErrorMessage(body);
  return `${summary}（${message ?? `HTTP ${status}`}）`;
}

/** 運営の画面の操作が通信エラー (fetch の例外) で終わったときに、画面に出す文 */
export function operationNetworkFailureMessage(summary: string): string {
  return `${summary}（通信エラー）`;
}
