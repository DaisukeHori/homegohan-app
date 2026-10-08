/**
 * ネイティブアプリ (React Native の WebView) への認証メッセージ (#1038 F7-04 / F7-05)
 *
 * モバイルアプリは Web をタブごとの WebView で表示する。ログイン状態の持ち主はネイティブ側で、
 * WebView には native-bridge (src/app/(auth)/auth/native-bridge/route.ts) が Cookie セッションを張る。
 * Web 側でセッションが終わったときは、次のメッセージでネイティブに知らせて、状態を揃えてもらう。
 *
 *   { type: 'sign-out' }
 *     利用者が Web 側でログアウトした (broadcastSignOut が送る)。
 *     ネイティブも同じようにログアウトして、ウェルカム画面へ戻る。
 *     これが無いと、Web だけがログアウトし、ネイティブは保存済みのセッションを持ったまま
 *     (最大 1 時間後に更新で失敗して突然ログアウトする) という食い違いになる (F7-04)。
 *
 *   { type: 'session-expired' }
 *     Web 側のセッションが切れた・切れそう (ログイン画面に落ちた・有効期限が近い)。
 *     ネイティブは自分のセッションを確かめ、WebView を新しい bridge で読み込み直す (F7-05)。
 *     Web 側は refresh_token を持たない (native-bridge が使えない値を入れる) ので、自分でトークンを更新しない。
 *     更新の持ち主をネイティブ 1 つにして、同じ refresh_token を Web とネイティブが別々にローテーションして
 *     再利用検知でセッションごと失効する、という不具合を防ぐ。
 *
 * 旧バージョンのアプリはこれらのメッセージを無視する (onMessage は未知の type を捨てる) ので、先に Web だけ出しても壊れない。
 * ネイティブ側の処理は apps/mobile/src/lib/webViewAuthMessages.ts。
 *
 * window.ReactNativeWebView が無い (普通のブラウザ) ときは、何もしない。
 */

export type NativeAuthMessage = { type: 'sign-out' } | { type: 'session-expired' }

/**
 * Web 側のセッション (Cookie) に入れる refresh_token の代わりの値 (#1038 F7-05)。
 *
 * ネイティブの refresh_token をそのまま Web の Cookie セッションにも入れると、Web (middleware / ブラウザの
 * supabase-js) とネイティブが同じ refresh_token を別々にローテーションする。片方が使った古い refresh_token を
 * もう片方が使うと、Supabase は再利用とみなしてセッションごと失効させ、ネイティブも Web も突然ログアウトする
 * (ランダムな強制ログアウト)。
 *
 * そこで、更新の持ち主をネイティブだけにする。native-bridge は Web の Cookie に access_token だけを実際の値で入れ、
 * refresh_token にはこの値 (Supabase には存在しないので、更新は必ず失敗する) を入れる。
 *   - access_token の有効期間 (既定 1 時間) の間は、Web はそのまま使える
 *   - 期限が近づいた Web 側は更新に失敗してセッションが消えるが、その前に { type: 'session-expired' } を送り
 *     (NativeSessionWatcher)、ネイティブが新しいコードで読み込み直す
 *   - ネイティブの refresh_token は、DB の行 (60 秒) と、コードを発行するリクエストの body 以外には出ない。
 *     Web のページが読める Cookie (HttpOnly でない) にも載らない
 *
 * 実際の値ではないが、秘密でもないので、定数として持つ。ブラウザ側の見張り (NativeSessionWatcher) が
 * 「ネイティブから借りたセッションか」を見分けるのにも使うため、サーバー専用の native-bridge-code.ts ではなくここに置く。
 */
export const NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER = 'native-bridge-web-session-no-refresh'

interface ReactNativeWebViewBridge {
  postMessage: (message: string) => void
}

/** session-expired を続けて送らない最小の間隔 (ミリ秒)。ネイティブ側にも回数制限があるが、Web 側でも送りすぎない */
export const SESSION_EXPIRED_MIN_INTERVAL_MS = 15_000

function getBridge(): ReactNativeWebViewBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as unknown as { ReactNativeWebView?: ReactNativeWebViewBridge }).ReactNativeWebView
  return bridge && typeof bridge.postMessage === 'function' ? bridge : null
}

/** ネイティブアプリの WebView の中で動いているか */
export function isInNativeWebView(): boolean {
  return getBridge() !== null
}

let signOutNotified = false
let lastSessionExpiredAt = 0

function post(bridge: ReactNativeWebViewBridge, message: NativeAuthMessage): boolean {
  try {
    bridge.postMessage(JSON.stringify(message))
    return true
  } catch {
    // 送れなくても Web 側の処理は止めない
    return false
  }
}

/**
 * Web 側でログアウトしたことをネイティブに知らせる。送ったら true。
 * 一度送ったら、このページが開いている間は session-expired を送らない (ログアウト後に再ブリッジを頼まない)。
 */
export function notifyNativeSignOut(): boolean {
  const bridge = getBridge()
  if (!bridge) return false
  signOutNotified = true
  return post(bridge, { type: 'sign-out' })
}

/**
 * Web 側のセッションが切れたことをネイティブに知らせ、再ブリッジを頼む。送ったら true。
 * ログアウト通知済みのとき、直前に送ったばかりのときは送らない。
 */
export function notifyNativeSessionExpired(now: number = Date.now()): boolean {
  const bridge = getBridge()
  if (!bridge) return false
  if (signOutNotified) return false
  if (now - lastSessionExpiredAt < SESSION_EXPIRED_MIN_INTERVAL_MS) return false
  lastSessionExpiredAt = now
  return post(bridge, { type: 'session-expired' })
}

/** テスト用: モジュールの状態を初期化する */
export function resetNativeAuthBridgeForTests(): void {
  signOutNotified = false
  lastSessionExpiredAt = 0
}
