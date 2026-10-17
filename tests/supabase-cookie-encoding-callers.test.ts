// @vitest-environment node
/**
 * @supabase/ssr のクライアントを作る口は、Cookie の書式を SUPABASE_COOKIE_ENCODING で明示する、の走査 (#1768。
 * docs/design/mobile/05-auth-session.md §9.5 の裁定 D・§9.9 F)
 *
 * ssr 0.12 の既定の書式 (base64url。値に base64- を付ける) にすると、デプロイの前に開いたタブの JS (ssr 0.1.0 + auth-js 2.105.3) と、
 * Vercel を旧版に戻したときの旧サーバーは、その Cookie を読めずにセッションを消して SIGNED_OUT を出す
 * (Cookie はブラウザで共有なので、そのブラウザの全タブが切れる)。書式は 'raw' (0.1.0 と同じ JSON) に保つ。
 *
 *   F-1 SUPABASE_COOKIE_ENCODING は 'raw'
 *   F-2 lib/supabase の 3 ファイルの createServerClient / createBrowserClient の呼び出しは、どれもその定数を渡す
 *   F-3 ssr のクライアントを値で作るのは、その 3 ファイルだけ (ほかの製品コードが書式を指定せずに作らない)
 *
 * 限界 (見張りであって証明ではない): 文字列の走査なので、定数を別名で渡す・オプションを別の変数にまとめて渡す書き方は捕まらない
 * (F-2 は渡し方を `cookieEncoding: SUPABASE_COOKIE_ENCODING` の 1 つの形に決めて数える)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SUPABASE_COOKIE_ENCODING } from '@/lib/supabase/cookie-encoding';
import { listFiles, rel, ROOT, stripComments } from './helpers/ai-reach';

const SSR_CLIENT_FILES = ['lib/supabase/client.ts', 'lib/supabase/server.ts', 'lib/supabase/middleware.ts'];
const SSR_MODULE = '@supabase/ssr';
const SSR_CLIENT_FACTORIES = ['createServerClient', 'createBrowserClient'];
const ENCODING_CONSTANT_MODULE = '@/lib/supabase/cookie-encoding';
/** 製品コードの置き場 (テストは除く)。apps/mobile は ssr を使わない */
const SCAN_ROOTS = ['src', 'lib', 'packages'];

const isProductionSource = (name: string) => /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\./.test(name) && !name.endsWith('.d.ts');

function readBody(file: string) {
  return stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

/** @supabase/ssr から値として import している名前 (`import type` と `type X` は数えない) */
function valueImportsFromSsr(body: string): string[] {
  const names: string[] = [];
  const importPattern = new RegExp(`import\\s+(?!type\\b)\\{([^}]*)\\}\\s+from\\s+['"]${SSR_MODULE}['"]`, 'g');
  for (const match of body.matchAll(importPattern)) {
    for (const part of match[1].split(',')) {
      const name = part.trim();
      if (name !== '' && !name.startsWith('type ')) names.push(name.split(/\s+as\s+/)[0]);
    }
  }
  return names;
}

describe('SUPABASE_COOKIE_ENCODING (#1768)', () => {
  it('F-1: SUPABASE_COOKIE_ENCODING は raw (ssr 0.1.0 と同じ JSON の書式。旧バンドルとロールバックが読める)', () => {
    expect(SUPABASE_COOKIE_ENCODING).toBe('raw');
  });

  it.each(SSR_CLIENT_FILES)('F-2: %s の createServerClient / createBrowserClient の呼び出しは、どれも cookieEncoding: SUPABASE_COOKIE_ENCODING を渡す', (file) => {
    const body = readBody(file);
    // ReturnType<typeof createServerClient> は ( が続かないので数えない
    const calls = body.match(/\bcreate(?:Server|Browser)Client\(/g) ?? [];
    const encodings = body.match(/\bcookieEncoding:\s*SUPABASE_COOKIE_ENCODING\b/g) ?? [];

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(encodings).toHaveLength(calls.length);
    expect(body).toContain(`from '${ENCODING_CONSTANT_MODULE}'`);
  });

  it('F-3: ssr のクライアントを値で作るのは lib/supabase の 3 ファイルだけ (ほかの製品コードが書式を指定せずに作らない)', () => {
    const creators: string[] = [];
    for (const scanRoot of SCAN_ROOTS) {
      const dir = path.join(ROOT, scanRoot);
      if (!fs.existsSync(dir)) continue;
      for (const file of listFiles(dir, isProductionSource)) {
        if (rel(file).includes('/__tests__/')) continue;
        const names = valueImportsFromSsr(stripComments(fs.readFileSync(file, 'utf8')));
        if (names.some((name) => SSR_CLIENT_FACTORIES.includes(name))) creators.push(rel(file));
      }
    }

    expect(creators.sort()).toEqual([...SSR_CLIENT_FILES].sort());
  });
});
