// Skip RNTL peer deps version check
// This is needed because the monorepo root has react@18 (for Next.js) while
// apps/mobile uses react@19. The check incorrectly picks up the root version.
process.env.RNTL_SKIP_DEPS_CHECK = '1';

// WebSocket polyfill for Node.js < 22
// @supabase/realtime-js detects the runtime at module load time. Without a
// WebSocket global, createClient() throws in Node 20. We provide the 'ws'
// package (available in the monorepo root) so tests can import supabase.ts.
if (typeof global.WebSocket === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ws = require('ws');
  global.WebSocket = ws;
}
