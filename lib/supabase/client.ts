import { createBrowserClient } from '@supabase/ssr'
// ブラウザのバンドルに入るので、zod を持つ @/lib/env ではなく何も import しない env-required を使う (#1182)
import { getSupabaseAnonKey, getSupabaseUrl } from '@/lib/env-required'

export function createClient() {
  // 未設定なら、変数名つきの MissingEnvError になる (`process.env.X!` では undefined のまま渡って分かりにくいエラーになっていた)
  return createBrowserClient(getSupabaseUrl(), getSupabaseAnonKey())
}
