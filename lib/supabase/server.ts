import { createServerClient } from '@supabase/ssr'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { cookies, headers } from 'next/headers'
import { getSupabaseAnonKey, getSupabaseServiceRoleKey, getSupabaseUrl } from '@/lib/env-required'
import { SUPABASE_COOKIE_ENCODING } from '@/lib/supabase/cookie-encoding'

/**
 * service_role キーで動作する Supabase クライアントを返す。
 * RLS を完全にバイパスするため、呼び出し側で **必ず requireRole 等の認可チェックを
 * 先に通した後**にのみ使用すること(認可前に使うと権限昇格になる)。
 *
 * admin/* の API ルートが管理者操作(他ユーザーの user_profiles 参照・更新等)を
 * 行う際の共通ヘルパー。#1028 で organizations route の重複実装を集約した。
 * #1162 で、運営の強制譲渡・強制解散・候補者一覧・クライアントログ・オーナー移譲の提案・献立キューの cron が
 * 自前で作っていたクライアントもここへ寄せた。service_role のクライアントは自前で createClient せず、必ずこれを使う
 * (tests/supabase-service-role-client-scan.test.ts が見張る。例外は理由つきの一覧にある)。
 *
 * 環境変数が欠けていれば MissingEnvError を投げる (#1182)。欠けている変数名は envName にあり、message には入らない。
 */
export function getSupabaseAdmin() {
  return createAdminClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/**
 * リクエストの Cookie と Authorization ヘッダを使う (RLS が効く) Supabase クライアントを返す。
 *
 * Next 15 では cookies() / headers() が Promise を返すので、この関数も非同期にした (#1444)。
 * 呼び出し側は `const supabase = await createClient()` と書く。
 * Next 15 には cookies() を同期のまま読む互換の道も残っているが、開発時に警告が出て、Next 16 で無くなるので使わない。
 */
export async function createClient(cookieStore?: Awaited<ReturnType<typeof cookies>>) {
  const store = cookieStore ?? (await cookies())
  const authHeader = (await headers()).get('authorization')

  return createServerClient(
    getSupabaseUrl(),
    getSupabaseAnonKey(),
    {
      global: authHeader ? { headers: { Authorization: authHeader } } : undefined,
      cookieEncoding: SUPABASE_COOKIE_ENCODING,
      cookies: {
        getAll() {
          return store.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) store.set({ name, value, ...options })
          } catch {
            // Server Component から呼ばれたとき (応答の Cookie に書けない)。
            // middleware (lib/supabase/middleware.ts) が同じ更新を応答に書くので無視してよい (#1768 より前の set / remove と同じ扱い)
          }
        },
      },
    }
  )
}
