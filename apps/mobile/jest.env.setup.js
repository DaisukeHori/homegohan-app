// Skip RNTL peer deps version check
// This is needed because the monorepo root has react@18 (for Next.js) while
// apps/mobile uses react@19. The check incorrectly picks up the root version.
process.env.RNTL_SKIP_DEPS_CHECK = '1';

// Node 20 には native WebSocket がないため ws polyfill を注入する。
// @supabase/realtime-js が WebSocket を要求するテスト suite で必要。
if (typeof global.WebSocket === 'undefined') {
  global.WebSocket = require('ws');
}
