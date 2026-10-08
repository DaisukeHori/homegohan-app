import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TURNSTILE_SCRIPT_SRC } from '@/lib/auth/turnstile';

// #1165 ログイン・新規登録・パスワード再設定の bot 対策 (Cloudflare Turnstile) の設定まわりの検査。
//
//   1. CSP: Cloudflare の api.js (script) とウィジェット (iframe) を許可する。許可は script-src と frame-src だけ
//   2. ローカルの Supabase は CAPTCHA を無効のままにする
//      (結合テスト・e2e・開発は、トークン無しで signInWithPassword / signUp を呼ぶ。有効にすると全部が止まる。
//       本番で CAPTCHA を有効にする時期は、モバイルの配布状況で決める。docs/operations/auth-protection.md)
//   3. 設定例のサイトキーは空 (コピーしただけでは Turnstile は有効にならない)
//   4. CI の e2e (e2e-local.yml) は Cloudflare 公式のテスト用サイトキーでビルドして、実際のウィジェットを通す

const ROOT = path.resolve(__dirname, '../../..');
const read = (relativePath: string) => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

const CLOUDFLARE_ORIGIN = 'https://challenges.cloudflare.com';
/** Cloudflare 公式のテスト用サイトキー「常に成功」(表示あり)。https://developers.cloudflare.com/turnstile/troubleshooting/testing/ */
const CLOUDFLARE_TEST_SITE_KEY = '1x00000000000000000000AA';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadCspDirectives(): Promise<Map<string, string[]>> {
  vi.resetModules();
  // next.config.mjs は import 時に process.env を読むので、クエリ文字列を付けてフレッシュに評価する
  const mod = await import(/* @vite-ignore */ `../../../next.config.mjs?t=${Date.now()}-${Math.random()}`);
  const headerGroups = await mod.default.headers();
  const securityGroup = headerGroups.find((group: any) => group.source === '/(.*)');
  const csp = securityGroup.headers.find((header: any) => header.key === 'Content-Security-Policy').value as string;
  return new Map(
    csp.split('; ').map((directive) => {
      const [name, ...sources] = directive.split(' ');
      return [name, sources] as [string, string[]];
    }),
  );
}

describe('Turnstile: CSP (next.config.mjs)', () => {
  it('script-src が Cloudflare の api.js を許可する。今までの許可 (self / unsafe-inline / vercel-scripts) は保つ', async () => {
    const csp = await loadCspDirectives();
    const scriptSrc = csp.get('script-src') ?? [];

    expect(scriptSrc).toContain(CLOUDFLARE_ORIGIN);
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).toContain('*.vercel-scripts.com');
  });

  it('frame-src が Cloudflare のウィジェット (iframe) を許可する。frame-src を足しても、自分のページの iframe は今までどおり許可する', async () => {
    const csp = await loadCspDirectives();
    const frameSrc = csp.get('frame-src') ?? [];

    expect(frameSrc).toContain(CLOUDFLARE_ORIGIN);
    // frame-src を書くと default-src へのフォールバックが無くなる。今まで効いていた 'self' を落とさない
    expect(frameSrc).toContain("'self'");
  });

  it('許可は script-src と frame-src だけ。default-src を広げず、ほかのページに iframe で埋め込まれることも許さない', async () => {
    const csp = await loadCspDirectives();

    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    for (const [directive, sources] of csp) {
      if (directive === 'script-src' || directive === 'frame-src') continue;
      expect(sources, `${directive} に Cloudflare を足していない`).not.toContain(CLOUDFLARE_ORIGIN);
    }
  });

  it('アプリが読み込む api.js の URL (src/lib/auth/turnstile.ts) のオリジンが、CSP の script-src にある', async () => {
    const csp = await loadCspDirectives();

    expect(new URL(TURNSTILE_SCRIPT_SRC).origin).toBe(CLOUDFLARE_ORIGIN);
    expect(csp.get('script-src')).toContain(new URL(TURNSTILE_SCRIPT_SRC).origin);
  });

  it('本番の Supabase (*.supabase.co) でも、ローカルの Supabase でも、Cloudflare の許可は変わらない', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    const local = await loadCspDirectives();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://flmeolcfutuwwbjmzyoz.supabase.co');
    const production = await loadCspDirectives();

    for (const csp of [local, production]) {
      expect(csp.get('script-src')).toContain(CLOUDFLARE_ORIGIN);
      expect(csp.get('frame-src')).toContain(CLOUDFLARE_ORIGIN);
    }
  });
});

describe('Turnstile: ローカルの Supabase は CAPTCHA を無効のままにする', () => {
  /** TOML の [テーブル] ごとに、行をまとめる (コメント行と空行は除く) */
  function tomlTables(source: string): Map<string, string[]> {
    const tables = new Map<string, string[]>();
    let current = '';
    for (const rawLine of source.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const header = line.match(/^\[([^\]]+)\]$/);
      if (header) {
        current = header[1].trim();
        tables.set(current, tables.get(current) ?? []);
      } else {
        tables.set(current, [...(tables.get(current) ?? []), line]);
      }
    }
    return tables;
  }

  it('supabase/config.toml は [auth.captcha] を有効にしていない (書くなら enabled = false)', () => {
    const tables = tomlTables(read('supabase/config.toml'));
    const captcha = tables.get('auth.captcha');

    // 書いていなければ、Supabase の既定 (無効)
    if (captcha !== undefined) {
      expect(captcha.some((line) => /^enabled\s*=\s*false\b/.test(line))).toBe(true);
      expect(captcha.some((line) => /^enabled\s*=\s*true\b/.test(line))).toBe(false);
    }
  });

  it('ローカル用の設定を組み立てる scripts/supabase-local.sh も、CAPTCHA を有効にしない', () => {
    const script = read('scripts/supabase-local.sh');

    expect(script).not.toMatch(/auth\.captcha/i);
    expect(script).not.toMatch(/GOTRUE_SECURITY_CAPTCHA/i);
  });

  it('CI のどの workflow も、ローカルの Supabase の CAPTCHA を有効にしていない', () => {
    const workflowDir = path.join(ROOT, '.github/workflows');
    for (const file of fs.readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
      const workflow = fs.readFileSync(path.join(workflowDir, file), 'utf-8');
      expect(workflow, `${file} が Supabase の CAPTCHA を有効にしている`).not.toMatch(/GOTRUE_SECURITY_CAPTCHA_ENABLED/i);
    }
  });
});

describe('Turnstile: 設定例のサイトキーは空 (コピーしただけでは有効にならない)', () => {
  it('.env.example の NEXT_PUBLIC_TURNSTILE_SITE_KEY は空', () => {
    const match = read('.env.example').match(/^NEXT_PUBLIC_TURNSTILE_SITE_KEY=(\S*)\s*$/m);

    expect(match, '.env.example に NEXT_PUBLIC_TURNSTILE_SITE_KEY= の行が見つからない').not.toBeNull();
    expect(match![1]).toBe('');
  });

  it('apps/mobile/env.example の EXPO_PUBLIC_TURNSTILE_SITE_KEY は空', () => {
    const match = read('apps/mobile/env.example').match(/^EXPO_PUBLIC_TURNSTILE_SITE_KEY=(\S*)\s*$/m);

    expect(match, 'apps/mobile/env.example に EXPO_PUBLIC_TURNSTILE_SITE_KEY= の行が見つからない').not.toBeNull();
    expect(match![1]).toBe('');
  });

  it('設定例やコードが案内する運用文書 docs/operations/auth-protection.md がある', () => {
    expect(fs.existsSync(path.join(ROOT, 'docs/operations/auth-protection.md'))).toBe(true);
    expect(read('.env.example')).toContain('docs/operations/auth-protection.md');
    expect(read('apps/mobile/env.example')).toContain('docs/operations/auth-protection.md');
  });
});

describe('Turnstile: CI の e2e (e2e-local.yml) は Cloudflare のテスト用サイトキーで実際のウィジェットを通す', () => {
  const workflow = () => read('.github/workflows/e2e-local.yml');

  it('アプリのビルドに、Cloudflare 公式のテスト用サイトキー (常に成功) を渡す', () => {
    // NEXT_PUBLIC_* はビルド時に埋め込まれるので、ビルドする step の env に書く
    const match = workflow().match(/^\s*NEXT_PUBLIC_TURNSTILE_SITE_KEY:\s*["']?([^"'\s#]+)["']?/m);

    expect(match, 'e2e-local.yml に NEXT_PUBLIC_TURNSTILE_SITE_KEY が無い').not.toBeNull();
    expect(match![1]).toBe(CLOUDFLARE_TEST_SITE_KEY);
  });

  it('Turnstile の spec を実行し、サイトキーが渡っていなければスキップせず失敗にする (キー無しで緑になるのを防ぐ)', () => {
    expect(workflow()).toContain('tests/e2e/auth-turnstile.spec.ts');
    expect(workflow()).toMatch(/^\s*E2E_REQUIRE_TURNSTILE:\s*["']?1["']?\s*$/m);
  });

  it('本番の URL を対象にする e2e.yml には、サイトキーを渡さない (起動済みのアプリには効かないため)', () => {
    expect(read('.github/workflows/e2e.yml')).not.toContain('TURNSTILE');
  });
});
