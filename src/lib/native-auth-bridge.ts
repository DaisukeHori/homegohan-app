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
 *     Web 側のセッションが切れた・切れそう (有効期限が近い・auth-js が更新に失敗して SIGNED_OUT を出した・ログイン画面に落ちた)。
 *     ネイティブは自分のセッションを確かめ、WebView を新しい bridge で読み込み直す (F7-05)。
 *     Web 側は refresh_token を持たない (native-bridge が使えない値を入れる) ので、自分でトークンを更新できない。
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
 *   - ネイティブの refresh_token は、DB の行 (60 秒) と、コードを発行するリクエストの body 以外には出ない。
 *     Web のページが読める Cookie (HttpOnly でない) にも載らない
 *   - 期限が近づくと、ブラウザの supabase-js (auth-js) は refresh_token で更新しようとして必ず失敗し、
 *     セッションを捨てて SIGNED_OUT を出す。auth-js が更新を試みるのは次の時点 (@supabase/auth-js 2.105)
 *       自動更新の tick (30 秒ごと)                       : 残りが 120 秒未満 ((AUTO_REFRESH_TICK_THRESHOLD + 1) × 30 秒)
 *       getSession() (Supabase への API 呼び出しのたびに) : 残りが 90 秒未満 (EXPIRY_MARGIN_MS)
 *       バックグラウンドからの復帰 (visibilitychange)     : 残りが 90 秒未満。このとき tick も直ちに走る
 *     これを次の 2 段構えで受ける
 *       1. 前面で使っているとき: auth-js より先に NativeSessionWatcher が { type: 'session-expired' } を送り
 *          (REFRESH_AHEAD_SECONDS = 180 秒。auth-js の 120 秒より十分に前)、ネイティブが新しいコードで読み込み直す。
 *          auth-js は更新を試みる前に済む
 *       2. 先回りできないとき (1 時間以上バックグラウンドに置いて戻った場合。タイマーも止まっているので、
 *          復帰した瞬間に auth-js が更新を試みる): MainLayout が、WebView の中での SIGNED_OUT を「ログアウト」ではなく
 *          「借り物のセッションを失った」ものとして扱う。localStorage を消さず、/login へも移さず、
 *          session-expired を送って再ブリッジを待つ (NATIVE_REBRIDGE_WAIT_MS)。
 *          利用者が意図したログアウトは、各画面が signOut の前に自分で localStorage を消し、broadcastSignOut() で sign-out を送る
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

/**
 * WebView の中で SIGNED_OUT になってから、ネイティブが WebView を読み込み直してくれるのを待つ時間 (ミリ秒)。
 * 過ぎても読み込み直されなければ、MainLayout は従来どおりログアウトとして扱う (user-scoped の localStorage を消して /login へ移る)。
 *
 * 読み込み直されない場合がある: session-expired を知らない旧バージョンのアプリ (実際の refresh_token を持つセッションの
 * 失効やログアウトで SIGNED_OUT になる)、ネイティブ側の回数制限、ネイティブも未ログイン、通信が極端に遅い。
 * ネイティブが読み込み直すと、ページごと入れ替わるので待ちは自然に終わる。
 * 通常の再ブリッジは数秒 (自分のセッションの確認 + コードの発行 + 読み込み) なので、それより十分に長くする。
 */
export const NATIVE_REBRIDGE_WAIT_MS = 15_000

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
