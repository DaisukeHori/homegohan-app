// Skip RNTL peer deps version check
// This is needed because the monorepo root has react@18 (for Next.js) while
// apps/mobile uses react@19. The check incorrectly picks up the root version.
process.env.RNTL_SKIP_DEPS_CHECK = '1';

// src/lib/supabase.ts は、EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY が無いと、開発モード
// (Jest でも __DEV__ は true) では読み込み時に例外を投げる (#1182。以前は placeholder の接続先でクライアントを作っていた)。
// supabase.ts をモックせずに読み込むテストのために、ダミーの値を既定で入れておく。値を変えたい・無い場合を
// 試したいテストは、自分で process.env を書き換える (__tests__/lib/supabase-config.test.ts など)。
process.env.EXPO_PUBLIC_SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://test-project.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'test-anon-key';

// Node 20 には native WebSocket がないため ws polyfill を注入する。
// @supabase/realtime-js が WebSocket を要求するテスト suite で必要。
if (typeof global.WebSocket === 'undefined') {
  global.WebSocket = require('ws');
}
