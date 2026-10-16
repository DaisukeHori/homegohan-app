/**
 * @supabase/ssr が認証の Cookie に書く値の書式 (#1768。docs/design/mobile/05-auth-session.md §9.5 の裁定 D)。
 *
 * 'raw' = auth-js が渡す JSON をそのまま書く (@supabase/ssr 0.1.0 と同じ値)。0.12 の既定の 'base64url' (値に base64- を付ける) にしない。
 * デプロイの前に開いたタブの JS (ssr 0.1.0 + auth-js 2.105.3) と、Vercel を旧版に戻したときの旧サーバーは base64- の値を読めず、
 * セッションを消して SIGNED_OUT を出す (Cookie はブラウザで共有なので、そのブラウザの全タブが切れる)。
 * 0.12 は書式の設定に依らず JSON と base64- の両方を読むので、'base64url' への切り替えは別の Issue で、0.1.0 の JS が残らないと見なせてから行う。
 * createServerClient / createBrowserClient を呼ぶ 3 ファイル (lib/supabase/client.ts・server.ts・middleware.ts) は必ずこの定数を渡す
 * (tests/supabase-cookie-encoding-callers.test.ts が見張る)。
 */
export const SUPABASE_COOKIE_ENCODING = 'raw' as const
