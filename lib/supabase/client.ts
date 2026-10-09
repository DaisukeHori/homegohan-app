import { createBrowserClient } from '@supabase/ssr'
// ブラウザのバンドルに入るので、zod を持つ @/lib/env ではなく何も import しない env-required を使う (#1182)
import { getSupabaseAnonKey, getSupabaseUrl } from '@/lib/env-required'

export function createClient() {
  // 未設定なら MissingEnvError になる (`process.env.X!` では undefined のまま渡って分かりにくいエラーになっていた)。
  // 欠けている変数名は envName にあり、message には入らない (どれが欠けているかは `npm run check:env` で分かる)
  return createBrowserClient(getSupabaseUrl(), getSupabaseAnonKey())
}
