'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER,
  isInNativeWebView,
  notifyNativeSessionExpired,
} from '@/lib/native-auth-bridge'

/** セッションの状態を確かめる間隔 (ミリ秒) */
export const SESSION_CHECK_INTERVAL_MS = 20_000

/**
 * 有効期限までの残りがこの秒数を切ったら、ネイティブに再ブリッジを頼む。
 *
 * Web 側の refresh_token は使えない値なので、auth-js (ブラウザの supabase-js) が更新を試みると必ず失敗して、
 * セッションが捨てられる (SIGNED_OUT)。auth-js が更新を試みるのは、残りが次の秒数を切ったとき (@supabase/auth-js 2.105)。
 *   - 自動更新の tick (30 秒ごと)               : 120 秒 ((AUTO_REFRESH_TICK_THRESHOLD + 1) × 30 秒)
 *   - getSession() ・前面への復帰 (visibilitychange): 90 秒 (EXPIRY_MARGIN_MS)
 * 前面で使っているときは、そのどれよりも先にネイティブへ頼めるよう、tick の 120 秒より十分に大きくする。
 * 確認の間隔 (SESSION_CHECK_INTERVAL_MS = 20 秒) だけ遅れて気づいても、ネイティブの再ブリッジに数秒かかっても、
 * まだ 120 秒より前になる (180 - 20 - 数秒)。以前の 120 秒は tick と同じ閾値で、tick が先に走ると (およそ 3 回に 1 回)
 * 借り物の refresh_token で更新して失敗していた。
 *
 * バックグラウンドに置いて戻ったときは、その間タイマーが止まっているので、どんな閾値でも先回りできない。
 * その場合の SIGNED_OUT は MainLayout が受ける (ログアウト扱いにせず、再ブリッジを頼む)。
 *
 * コード方式の bridge (#1036 / #1289 の webViewBridge.ts) は、ネイティブのアクセストークンの残りが
 * BRIDGE_MIN_TOKEN_TTL_SEC に満たなければ、コードを発行してもらう前に先に更新する。受け取った Web セッションの残りが
 * この値を下回ると、受け取った直後にまた再ブリッジを頼むことになる (1 回余分に読み込み直すだけ)。そうならないよう、
 * BRIDGE_MIN_TOKEN_TTL_SEC は「この値 + コードの有効期間 (60 秒) + 余裕」以上にそろえておく。
 */
export const REFRESH_AHEAD_SECONDS = 180

/**
 * ネイティブアプリの WebView の中で、Web 側のセッションの寿命を見張り、切れる前にネイティブへ知らせる (#1038 F7-05)。
 *
 * ログイン状態の持ち主はネイティブで、Web 側の Cookie セッションは native-bridge が張った借り物。
 * Web 側は refresh_token を持たず自分では更新できないので (src/app/(auth)/auth/native-bridge/route.ts)、
 * 期限が近づいたら { type: 'session-expired' } を送り、ネイティブに新しい bridge で読み込み直してもらう。
 * 送り方と意味は src/lib/native-auth-bridge.ts を参照。
 *
 * 次の場合は何もしない:
 *   - 普通のブラウザ (window.ReactNativeWebView が無い)
 *   - 実際の refresh_token を持つセッション (Web が自分で更新できる)
 *   - 通信エラーで状態が分からないとき (一時的なものを「切れた」と誤判定して読み込み直させない)
 *
 * 認証が必要なページの共通レイアウト (MainLayout) に置く。
 */
export function NativeSessionWatcher() {
  useEffect(() => {
    if (!isInNativeWebView()) return

    const supabase = createClient()
    let disposed = false

    const check = async () => {
      try {
        const { data, error } = await supabase.auth.getSession()
        if (disposed) return
        if (error && (error as { name?: string }).name === 'AuthRetryableFetchError') return

        const session = data?.session
        if (!session) {
          notifyNativeSessionExpired()
          return
        }
        // 見張るのは、ネイティブから借りたセッション (refresh_token が使えない値) だけ。
        // 実際の refresh_token を持つセッション (旧アプリの bridge、または Web のログイン画面で普通にログインした場合) は、
        // Web が自分で更新できるので、読み込み直させる必要がない
        if (session.refresh_token !== NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER) return
        if (typeof session.expires_at === 'number' && session.expires_at - Date.now() / 1000 < REFRESH_AHEAD_SECONDS) {
          notifyNativeSessionExpired()
        }
      } catch {
        // 状態が分からないときは何もしない
      }
    }

    void check()
    const timer = setInterval(() => void check(), SESSION_CHECK_INTERVAL_MS)
    // アプリが前面に戻ったとき (バックグラウンド中はタイマーが止まる) にもすぐ確かめる
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      disposed = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  return null
}
