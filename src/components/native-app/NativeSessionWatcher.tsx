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
 * auth-js は残り 90 秒 (EXPIRY_MARGIN_MS) を切ると、getSession() などの中で refresh_token による更新を試みる。
 * Web 側の refresh_token は使えない値なので、その更新は失敗してセッションが消える。
 * 確認の間隔 (20 秒) と余裕を見て、その前に頼む。
 */
export const REFRESH_AHEAD_SECONDS = 120

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
