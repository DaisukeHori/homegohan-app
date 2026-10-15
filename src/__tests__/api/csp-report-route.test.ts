// @vitest-environment node
/**
 * #1169 CSP の違反の報告の受け口 (POST /api/csp-report) のテスト。
 * 守りの順 (NULL 文字 → 回数制限 → Content-Type → 本文の上限 → JSON と Zod) と、通った報告だけが
 * createLogger('csp-report').warn で app_logs に残ること・4xx はどれも残さないことを確かめる
 * (設計 docs/design/cross/18-csp-nonce.md §9.4・§11・§13・§15)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { NULL_CHARACTER_ERROR_CODE } from '@/lib/api/null-character';
import { CSP_REPORT_ERROR_CODES, CSP_REPORT_LOG_FUNCTION_NAME, CSP_REPORT_MAX_BYTES } from '@/lib/security/csp-report';

// セッションを読まないことを確かめる (createClient が呼ばれたら記録される)
const mockCreateClient = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/server', () => ({ createClient: mockCreateClient, getSupabaseAdmin: vi.fn() }));

// 構造化ログ。function_name ごとの warn / error を記録する (app_logs への insert はしない)
const logMocks = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), createLogger: vi.fn() }));
vi.mock('@/lib/db-logger', () => {
  logMocks.createLogger.mockImplementation((routeName: string) => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => logMocks.warn(routeName, ...args),
    error: (...args: unknown[]) => logMocks.error(routeName, ...args),
    withUser: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  }));
  return { createLogger: logMocks.createLogger, generateRequestId: vi.fn(() => 'req_test') };
});

// 回数制限は本物 (Upstash を設定しない in-memory の数え方) を通し、呼ばれ方を記録する。
// 実行環境に Upstash の設定があっても外の Redis に繋がないよう、モジュールを読み込む前に外す
const rateLimitMocks = vi.hoisted(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  return { checkRateLimit: vi.fn() };
});
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>();
  rateLimitMocks.checkRateLimit.mockImplementation(actual.checkRateLimit);
  return { ...actual, checkRateLimit: rateLimitMocks.checkRateLimit };
});

const { POST } = await import('@/app/api/csp-report/route');

/** 回数制限の分あたりの枠 (src/lib/rate-limit.ts の csp-report) */
const CSP_REPORT_PER_MINUTE = 30;

const VALID_BODY = {
  'csp-report': {
    'document-uri': 'https://homegohan.example/invite/abcDEF1234567890xyz?next=%2Fhome#x',
    referrer: 'https://homegohan.example/',
    'violated-directive': 'script-src-elem',
    'effective-directive': 'script-src-elem',
    'original-policy': "default-src 'self'; report-uri /api/csp-report",
    disposition: 'enforce',
    'blocked-uri': 'inline',
    'line-number': 3,
    'column-number': 9,
    'source-file': 'https://homegohan.example/login?token=secret',
    'status-code': 200,
    'script-sample': 'alert(1)',
  },
};

let ipSeq = 0;
/** テストごとに違う IP (回数制限の枠をテストの間で共有しない) */
function nextIp(): string {
  ipSeq += 1;
  return `198.51.100.${ipSeq}`;
}

function makeRequest(options: { body: string; contentType?: string | null; ip?: string; userAgent?: string }): NextRequest {
  const headers: Record<string, string> = { 'x-forwarded-for': `${options.ip ?? nextIp()}, 10.0.0.1` };
  if (options.contentType !== null) headers['content-type'] = options.contentType ?? 'application/csp-report';
  if (options.userAgent !== undefined) headers['user-agent'] = options.userAgent;
  return new NextRequest('http://localhost/api/csp-report', { method: 'POST', headers, body: options.body });
}

function cspReportWarnCalls(): unknown[][] {
  return logMocks.warn.mock.calls.filter((call) => call[0] === CSP_REPORT_LOG_FUNCTION_NAME);
}

beforeEach(() => {
  logMocks.warn.mockClear();
  logMocks.error.mockClear();
  logMocks.createLogger.mockClear();
  mockCreateClient.mockClear();
  rateLimitMocks.checkRateLimit.mockClear();
});

describe('POST /api/csp-report (#1169)', () => {
  it('application/csp-report の有効な報告は 204 で、createLogger(\'csp-report\').warn が message と metadata (スクラブ済み) で 1 回呼ばれる', async () => {
    const res = await POST(makeRequest({ body: JSON.stringify(VALID_BODY), userAgent: 'Mozilla/5.0 Test' }));

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(logMocks.createLogger).toHaveBeenCalledWith('csp-report');
    const calls = cspReportWarnCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'csp-report',
      'CSP violation: script-src-elem blocked inline',
      {
        effective_directive: 'script-src-elem',
        violated_directive: 'script-src-elem',
        blocked_uri: 'inline',
        document_uri: 'https://homegohan.example/invite/[redacted]',
        source_file: 'https://homegohan.example/login',
        line_number: 3,
        column_number: 9,
        disposition: 'enforce',
        status_code: 200,
        script_sample: 'alert(1)',
        user_agent: 'Mozilla/5.0 Test',
      },
    ]);
    expect(JSON.stringify(calls[0])).not.toContain('secret');
    expect(JSON.stringify(calls[0])).not.toContain('report-uri');
  });

  it('application/json でも 204', async () => {
    const res = await POST(makeRequest({ body: JSON.stringify(VALID_BODY), contentType: 'application/json; charset=utf-8' }));

    expect(res.status).toBe(204);
    expect(cspReportWarnCalls()).toHaveLength(1);
  });

  it('Content-Type が text/plain なら 415 CSP_REPORT_UNSUPPORTED_MEDIA_TYPE で warn は呼ばれない', async () => {
    for (const contentType of ['text/plain', null]) {
      const res = await POST(makeRequest({ body: JSON.stringify(VALID_BODY), contentType }));

      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: '報告の形が不正です', code: CSP_REPORT_ERROR_CODES.unsupportedMediaType });
    }
    expect(CSP_REPORT_ERROR_CODES.unsupportedMediaType).toBe('CSP_REPORT_UNSUPPORTED_MEDIA_TYPE');
    expect(cspReportWarnCalls()).toHaveLength(0);
  });

  it('8 KiB を超える本文は 413 CSP_REPORT_TOO_LARGE', async () => {
    expect(CSP_REPORT_MAX_BYTES).toBe(8 * 1024);
    const prefix = '{"csp-report":{"script-sample":"';
    const suffix = '"}}';
    const fill = (bytes: number) => `${prefix}${'a'.repeat(bytes - prefix.length - suffix.length)}${suffix}`;

    const atLimit = await POST(makeRequest({ body: fill(CSP_REPORT_MAX_BYTES) }));
    expect(atLimit.status).toBe(204);

    const overLimit = await POST(makeRequest({ body: fill(CSP_REPORT_MAX_BYTES + 1) }));
    expect(overLimit.status).toBe(413);
    expect(await overLimit.json()).toEqual({ error: '報告の形が不正です', code: 'CSP_REPORT_TOO_LARGE' });

    // バイト数で数える (日本語 1 文字 = 3 バイト。文字数では上限に届かない本文も断る)
    const multiByte = `${prefix}${'違'.repeat(Math.ceil(CSP_REPORT_MAX_BYTES / 3))}${suffix}`;
    expect(multiByte.length).toBeLessThan(CSP_REPORT_MAX_BYTES);
    expect((await POST(makeRequest({ body: multiByte }))).status).toBe(413);

    expect(cspReportWarnCalls()).toHaveLength(1);
  });

  it('JSON でない本文・csp-report の無い本文は 400 CSP_REPORT_INVALID', async () => {
    for (const body of ['not json', '', '{"csp-report":', JSON.stringify({ report: {} }), JSON.stringify({ 'csp-report': 'x' }), 'null']) {
      const res = await POST(makeRequest({ body }));

      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: '報告の形が不正です', code: 'CSP_REPORT_INVALID' });
    }
    expect(cspReportWarnCalls()).toHaveLength(0);
  });

  it('NULL 文字を含む本文は 400 INVALID_CHARACTER (回数制限より前)', async () => {
    const body = JSON.stringify({ 'csp-report': { 'blocked-uri': 'inline\u0000' } });
    const res = await POST(makeRequest({ body }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({ code: NULL_CHARACTER_ERROR_CODE }));
    expect(rateLimitMocks.checkRateLimit).not.toHaveBeenCalled();
    expect(cspReportWarnCalls()).toHaveLength(0);
  });

  it('同じ IP から 31 回目は 429 RATE_LIMITED (in-memory)。x-forwarded-for の先頭を key にする', async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < CSP_REPORT_PER_MINUTE + 1; i++) {
      statuses.push((await POST(makeRequest({ body: JSON.stringify(VALID_BODY), ip }))).status);
    }

    expect(statuses.slice(0, CSP_REPORT_PER_MINUTE).every((status) => status === 204)).toBe(true);
    expect(statuses[CSP_REPORT_PER_MINUTE]).toBe(429);
    expect(rateLimitMocks.checkRateLimit).toHaveBeenCalledWith(ip, 'csp-report');
    expect(rateLimitMocks.checkRateLimit.mock.calls.every((call) => call[0] === ip && call[1] === 'csp-report')).toBe(true);

    const limited = await POST(makeRequest({ body: JSON.stringify(VALID_BODY), ip }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual(expect.objectContaining({ code: 'RATE_LIMITED' }));
    // 超えた分は app_logs に残さない
    expect(cspReportWarnCalls()).toHaveLength(CSP_REPORT_PER_MINUTE);

    // 別の IP は別に数える
    expect((await POST(makeRequest({ body: JSON.stringify(VALID_BODY) }))).status).toBe(204);
  });

  it('checkRateLimit が例外を投げたら 500 INTERNAL_ERROR (fail-closed)', async () => {
    rateLimitMocks.checkRateLimit.mockRejectedValueOnce(new Error('upstash down: secret-detail'));
    const res = await POST(makeRequest({ body: JSON.stringify(VALID_BODY) }));

    expect(res.status).toBe(500);
    const json: unknown = await res.json();
    expect(JSON.stringify(json)).toContain('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('secret-detail');
    expect(cspReportWarnCalls()).toHaveLength(0);
  });

  it('セッションを読まない (createClient を呼ばない)', async () => {
    await POST(makeRequest({ body: JSON.stringify(VALID_BODY) }));
    await POST(makeRequest({ body: 'not json' }));

    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
