import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { cookies, headers } from 'next/headers'
import { getSupabaseAnonKey, getSupabaseServiceRoleKey, getSupabaseUrl } from '@/lib/env-required'

/**
 * service_role キーで動作する Supabase クライアントを返す。
 * RLS を完全にバイパスするため、呼び出し側で **必ず requireRole 等の認可チェックを
 * 先に通した後**にのみ使用すること(認可前に使うと権限昇格になる)。
 *
 * admin/* の API ルートが管理者操作(他ユーザーの user_profiles 参照・更新等)を
 * 行う際の共通ヘルパー。#1028 で organizations route の重複実装を集約した。
 *
 * 環境変数が欠けていれば、欠けている変数名つきの MissingEnvError を投げる (#1182)。
 */
export function getSupabaseAdmin() {
  return createAdminClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export function createClient(cookieStore?: ReturnType<typeof cookies>) {
  const store = cookieStore || cookies()
  const authHeader = headers().get('authorization')

  return createServerClient(
    getSupabaseUrl(),
    getSupabaseAnonKey(),
    {
      global: authHeader ? { headers: { Authorization: authHeader } } : undefined,
      cookies: {
        get(name: string) {
          return store.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            store.set({ name, value, ...options })
          } catch {
            // The `set` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            store.set({ name, value: '', ...options })
          } catch {
            // The `delete` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}
