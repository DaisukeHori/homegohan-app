/**
 * updateSession (lib/supabase/middleware.ts) を呼ぶテスト用の、必須の公開用環境変数のダミー (#1182)
 *
 * updateSession は NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が無いと、認証を素通りさせず
 * 汎用の 500 を返して止まる。vitest の設定ではこの 2 つを入れていない (scripts/local-ci.sh も Supabase の変数を
 * テストへ通さない) ので、updateSession を呼ぶテストは、このヘルパーで値を入れてから呼ぶ。
 * Supabase のクライアント (@supabase/ssr の createServerClient) はどのテストもモックするので、値はダミーでよい。
 *
 * vi.unstubAllEnvs() はこの 2 つも消す。unstubAllEnvs のあと (フラグを入れ直す setUp の中など) で呼び直す。
 * 未設定のときの挙動を確かめるテストは、呼んだあとで vi.stubEnv(name, undefined) にする。
 *
 * このファイルはテストではない (名前に .test が無いので vitest は集めない)。置き場が __tests__ なので、
 * tests/env-source-scan.test.ts の本番コードの走査にも入らない。
 */
import { vi } from 'vitest';

export const TEST_SUPABASE_URL = 'https://example.supabase.co';
export const TEST_SUPABASE_ANON_KEY = 'anon-key-for-test';

export function stubSupabasePublicEnv(): void {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', TEST_SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', TEST_SUPABASE_ANON_KEY);
}
