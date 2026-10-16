// @vitest-environment node
/**
 * #1169: 本番の CSP の方針 (src/lib/security/csp.ts) の検査 (docs/design/cross/18-csp-nonce.md §15・§21)。
 *
 * 方針の正本は csp.ts の 1 か所で、src/middleware.ts が毎リクエスト nonce つきで付ける (next.config.mjs には書かない)。
 * 以前 next.config.mjs の CSP を見ていた検査 (#1166 PostHog・F6-09 の許可済みドメイン・Supabase の origin) もここへ移した。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TURNSTILE_SCRIPT_SRC } from '@/lib/auth/turnstile';
import {
  CSP_HEADER,
  CSP_NONCE_BYTES,
  CSP_NONCE_PATTERN,
  CSP_REPORT_ONLY_HEADER,
  CSP_REPORT_PATH,
  CSP_TURNSTILE_ORIGIN,
  buildContentSecurityPolicy,
  cspDirectivesOf,
  cspHeaderName,
  generateCspNonce,
  isCspReportOnly,
  supabaseLocalOrigins,
} from '@/lib/security/csp';

const ROOT = path.resolve(__dirname, '../../../..');
const CSP_SOURCE_FILE = 'src/lib/security/csp.ts';

/** 見本の nonce (base64) */
const SAMPLE_NONCE = 'dGVzdG5vbmNlMTIzNDU2Nzg=';
/** 本番の Supabase の URL の見本 */
const PRODUCTION_SUPABASE_URL = 'https://flmeolcfutuwwbjmzyoz.supabase.co';
/** ローカルの Supabase (scripts/supabase-local.sh) の URL */
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
/** base64 の nonce の文字数 (16 バイト → 24 文字) */
const NONCE_BASE64_LENGTH = 24;
/** 一意性を確かめる生成の回数 */
const NONCE_UNIQUENESS_SAMPLES = 100;

function productionPolicy(supabaseUrl: string | undefined = PRODUCTION_SUPABASE_URL): string {
  return buildContentSecurityPolicy({ nonce: SAMPLE_NONCE, isDev: false, supabaseUrl });
}

function directive(policy: string, name: string): string[] {
  const sources = cspDirectivesOf(policy).get(name);
  expect(sources, `方針に ${name} が無い`).toBeDefined();
  return sources ?? [];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildContentSecurityPolicy (#1169)', () => {
  it("本番の方針: script-src は 'self'・'nonce-<nonce>'・'report-sample'・*.vercel-scripts.com・https://challenges.cloudflare.com を持ち、'unsafe-inline' と 'unsafe-eval' を持たない", () => {
    const scriptSrc = directive(productionPolicy(), 'script-src');

    expect(scriptSrc).toEqual([
      "'self'",
      `'nonce-${SAMPLE_NONCE}'`,
      "'report-sample'",
      '*.vercel-scripts.com',
      'https://challenges.cloudflare.com',
    ]);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("dev の方針: script-src に 'unsafe-eval' が足され、'unsafe-inline' は無い", () => {
    const policy = buildContentSecurityPolicy({ nonce: SAMPLE_NONCE, isDev: true, supabaseUrl: PRODUCTION_SUPABASE_URL });
    const scriptSrc = directive(policy, 'script-src');

    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).toContain(`'nonce-${SAMPLE_NONCE}'`);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("style-src は 'self' 'unsafe-inline' のまま (据え置き)", () => {
    expect(directive(productionPolicy(), 'style-src')).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('default-src・frame-src・frame-ancestors・font-src・object-src は next.config.mjs にあった値と同じ', () => {
    const policy = productionPolicy();

    expect(directive(policy, 'default-src')).toEqual(["'self'"]);
    expect(directive(policy, 'frame-src')).toEqual(["'self'", 'https://challenges.cloudflare.com']);
    expect(directive(policy, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(policy, 'font-src')).toEqual(["'self'"]);
    expect(directive(policy, 'object-src')).toEqual(["'none'"]);
  });

  it(`frame-src の 1 行は "frame-src 'self' https://challenges.cloudflare.com" と文字どおりに書いてある (apps/mobile の Jest が読む)`, () => {
    const source = fs.readFileSync(path.join(ROOT, CSP_SOURCE_FILE), 'utf8');

    expect(source).toContain(`"frame-src 'self' https://challenges.cloudflare.com"`);
    expect(productionPolicy()).toContain("frame-src 'self' https://challenges.cloudflare.com;");
  });

  it(`csp.ts のソース (fs で読む) で /"frame-src\\s+/g に当たるのは 1 か所だけで、その捕捉は 'self' https://challenges.cloudflare.com (コメントに二重引用符つきの frame-src があると apps/mobile の Jest が先に拾う)`, () => {
    const source = fs.readFileSync(path.join(ROOT, CSP_SOURCE_FILE), 'utf8');

    expect(source.match(/"frame-src\s+/g) ?? []).toHaveLength(1);
    // apps/mobile/__tests__/lib/webViewBridge.test.ts と同じ正規表現 (最初の一致を使う)
    const captured = /"frame-src\s+([^"]+)"/.exec(source);
    expect(captured?.[1]).toBe("'self' https://challenges.cloudflare.com");
  });

  it('report-uri は /api/csp-report', () => {
    expect(directive(productionPolicy(), 'report-uri')).toEqual([CSP_REPORT_PATH]);
    expect(CSP_REPORT_PATH).toBe('/api/csp-report');
  });

  it('本番の Supabase (*.supabase.co) では connect-src / img-src に個別の origin を足さない', () => {
    const policy = productionPolicy(PRODUCTION_SUPABASE_URL);

    expect(policy).toContain("img-src 'self' data: blob: *.supabase.co images.unsplash.com;");
    expect(policy).toContain("connect-src 'self' *.supabase.co *.vercel.app wss://*.supabase.co;");
    expect(supabaseLocalOrigins(PRODUCTION_SUPABASE_URL)).toBeNull();
  });

  it('ローカルの Supabase (http://127.0.0.1:54321) は connect-src (http / ws) と img-src に足す', () => {
    const policy = productionPolicy(LOCAL_SUPABASE_URL);

    expect(directive(policy, 'connect-src')).toEqual(
      expect.arrayContaining(['http://127.0.0.1:54321', 'ws://127.0.0.1:54321']),
    );
    expect(directive(policy, 'img-src')).toContain('http://127.0.0.1:54321');
    expect(supabaseLocalOrigins(LOCAL_SUPABASE_URL)).toEqual({
      http: 'http://127.0.0.1:54321',
      ws: 'ws://127.0.0.1:54321',
    });
    // https のローカル (自前の証明書) は wss
    expect(supabaseLocalOrigins('https://supabase.local:8443')?.ws).toBe('wss://supabase.local:8443');
    // 未設定・URL でない値は方針を変えない
    expect(supabaseLocalOrigins(undefined)).toBeNull();
    expect(supabaseLocalOrigins('not a url')).toBeNull();
    expect(buildContentSecurityPolicy({ nonce: SAMPLE_NONCE, isDev: false, supabaseUrl: undefined })).toBe(
      productionPolicy(PRODUCTION_SUPABASE_URL),
    );
  });

  it('nonce が base64 でなければ throw', () => {
    for (const nonce of ["abc'; script-src *", 'abc def', 'abc;', '', 'abc"', 'a=b']) {
      expect(() => buildContentSecurityPolicy({ nonce, isDev: false, supabaseUrl: undefined }), nonce).toThrow(
        'CSP nonce must be base64',
      );
    }
    expect(() => buildContentSecurityPolicy({ nonce: SAMPLE_NONCE, isDev: false, supabaseUrl: undefined })).not.toThrow();
  });
});

describe('generateCspNonce (#1169)', () => {
  it('generateCspNonce: 24 文字の base64 で、100 回で重複しない', () => {
    const nonces = Array.from({ length: NONCE_UNIQUENESS_SAMPLES }, () => generateCspNonce());

    for (const nonce of nonces) {
      expect(nonce).toHaveLength(NONCE_BASE64_LENGTH);
      expect(nonce).toMatch(CSP_NONCE_PATTERN);
      // 16 バイトの乱数 (CSP3 の 128 ビット以上)
      expect(Buffer.from(nonce, 'base64')).toHaveLength(CSP_NONCE_BYTES);
    }
    expect(new Set(nonces).size).toBe(NONCE_UNIQUENESS_SAMPLES);
  });
});

describe('cspDirectivesOf (#1169)', () => {
  it('cspDirectivesOf: 方針を名前 → 許可先にする (空の区切りは飛ばす)', () => {
    const directives = cspDirectivesOf("default-src 'self';; script-src  'self'   a.example ; ;object-src 'none';");

    expect([...directives.keys()]).toEqual(['default-src', 'script-src', 'object-src']);
    expect(directives.get('script-src')).toEqual(["'self'", 'a.example']);
    expect(directives.get('object-src')).toEqual(["'none'"]);
  });
});

describe('isCspReportOnly / cspHeaderName (#1169)', () => {
  it("isCspReportOnly: 'on' (大小・前後の空白は無視) だけ true。off / 空 / true / 1 / undefined は false", () => {
    for (const value of ['on', 'ON', ' On ', '\ton\n']) {
      expect(isCspReportOnly(value), JSON.stringify(value)).toBe(true);
    }
    for (const value of ['off', '', ' ', 'true', '1', 'yes', 'o n', undefined]) {
      expect(isCspReportOnly(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('isCspReportOnly: 引数なしなら環境変数 CSP_REPORT_ONLY を読む', () => {
    vi.stubEnv('CSP_REPORT_ONLY', 'on');
    expect(isCspReportOnly()).toBe(true);
    vi.stubEnv('CSP_REPORT_ONLY', 'off');
    expect(isCspReportOnly()).toBe(false);
  });

  it('cspHeaderName: 強制と報告だけでヘッダー名が変わる', () => {
    expect(cspHeaderName(false)).toBe(CSP_HEADER);
    expect(cspHeaderName(true)).toBe(CSP_REPORT_ONLY_HEADER);
    expect(CSP_HEADER).toBe('Content-Security-Policy');
    expect(CSP_REPORT_ONLY_HEADER).toBe('Content-Security-Policy-Report-Only');
  });
});

describe('許可済みのドメイン (以前は next.config.mjs の CSP を見ていた検査)', () => {
  it('CSP_TURNSTILE_ORIGIN は src/lib/auth/turnstile.ts の TURNSTILE_SCRIPT_SRC のオリジンと同じで、script-src と frame-src の両方にある', () => {
    const policy = productionPolicy();

    expect(CSP_TURNSTILE_ORIGIN).toBe(new URL(TURNSTILE_SCRIPT_SRC).origin);
    expect(directive(policy, 'script-src')).toContain(CSP_TURNSTILE_ORIGIN);
    expect(directive(policy, 'frame-src')).toContain(CSP_TURNSTILE_ORIGIN);
  });

  it("F6-09: 既存の許可済みドメイン (*.supabase.co・*.vercel.app・wss://*.supabase.co・*.vercel-scripts.com・images.unsplash.com・font-src 'self') は壊れていない", () => {
    const policy = productionPolicy();

    expect(directive(policy, 'connect-src')).toEqual(
      expect.arrayContaining(['*.supabase.co', '*.vercel.app', 'wss://*.supabase.co']),
    );
    expect(directive(policy, 'script-src')).toContain('*.vercel-scripts.com');
    expect(directive(policy, 'img-src')).toEqual(expect.arrayContaining(['*.supabase.co', 'images.unsplash.com']));
    expect(directive(policy, 'font-src')).toEqual(["'self'"]);
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
  });

  // #1166: 利用状況の計測 (PostHog) はやめた。CSP が PostHog への送信を許していると、
  // 後から SDK を入れ直したときに黙って送信できてしまうので、許可の復活を止める。
  it('#1166: connect-src に PostHog のホストを含まない', () => {
    const policy = productionPolicy();

    expect(directive(policy, 'connect-src').length).toBeGreaterThan(0);
    expect(policy.toLowerCase()).not.toContain('posthog');
  });

  it('#1166: NEXT_PUBLIC_POSTHOG_HOST が環境に残っていても、方針に PostHog のホストを出さない', () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com');
    const policy = productionPolicy();

    expect(policy).not.toContain('eu.i.posthog.com');
    expect(policy.toLowerCase()).not.toContain('posthog');
  });
});
