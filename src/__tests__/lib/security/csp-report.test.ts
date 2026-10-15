// @vitest-environment node
/**
 * #1169 CSP の違反の報告 (src/lib/security/csp-report.ts) の単体テスト。
 * 本文の形 (Zod)・Content-Type・本文のバイト数・URL のスクラブ・app_logs に残す 1 行の形を確かめる
 * (設計 docs/design/cross/18-csp-nonce.md §9.3・§15)。
 */
import { describe, expect, it } from 'vitest';
import {
  CSP_REPORT_REDACTED_SEGMENT,
  CSP_REPORT_SCRIPT_SAMPLE_MAX_CHARS,
  CSP_REPORT_USER_AGENT_MAX_CHARS,
  CspReportBodySchema,
  cspReportByteLength,
  isCspReportContentType,
  scrubCspReportUri,
  toCspViolationLogEntry,
  type CspReport,
} from '@/lib/security/csp-report';

const ORIGINAL_POLICY = "default-src 'self'; script-src 'self' 'nonce-abc' 'report-sample'; report-uri /api/csp-report";

/** Chrome が送る形 (report-uri。数は数値・disposition あり) */
const CHROME_REPORT = {
  'csp-report': {
    'document-uri': 'https://homegohan.example/login?next=%2Fhome',
    referrer: 'https://homegohan.example/',
    'violated-directive': 'script-src-elem',
    'effective-directive': 'script-src-elem',
    'original-policy': ORIGINAL_POLICY,
    disposition: 'enforce',
    'blocked-uri': 'inline',
    'line-number': 12,
    'column-number': 7,
    'source-file': 'https://homegohan.example/login',
    'status-code': 200,
    'script-sample': 'alert(1)',
  },
};

/** Firefox が送る形 (effective-directive が無いことがある・source-file に数が付かない) */
const FIREFOX_REPORT = {
  'csp-report': {
    'blocked-uri': 'inline',
    'column-number': 1,
    'document-uri': 'https://homegohan.example/',
    'line-number': 3,
    'original-policy': ORIGINAL_POLICY,
    referrer: '',
    'script-sample': '',
    'source-file': 'https://homegohan.example/',
    'violated-directive': "script-src 'self' 'nonce-abc'",
  },
};

/** Safari が送る形 (ほぼ Chrome と同じで disposition が無い) */
const SAFARI_REPORT = {
  'csp-report': {
    'document-uri': 'https://homegohan.example/home',
    referrer: '',
    'violated-directive': 'script-src',
    'effective-directive': 'script-src',
    'original-policy': ORIGINAL_POLICY,
    'blocked-uri': 'eval',
    'status-code': 0,
  },
};

describe('CspReportBodySchema', () => {
  it('CspReportBodySchema: ブラウザが送る形 (Chrome / Firefox / Safari の例) を通し、知らないキーは捨てる', () => {
    for (const body of [CHROME_REPORT, FIREFOX_REPORT, SAFARI_REPORT]) {
      expect(CspReportBodySchema.safeParse(body).success).toBe(true);
    }
    const withUnknown = { 'csp-report': { ...CHROME_REPORT['csp-report'], 'unknown-key': 'x' }, extra: 1 };
    const parsed = CspReportBodySchema.safeParse(withUnknown);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).not.toHaveProperty('extra');
    expect(parsed.data['csp-report']).not.toHaveProperty('unknown-key');
    expect(parsed.data['csp-report']['blocked-uri']).toBe('inline');
    expect(parsed.data['csp-report']['line-number']).toBe(12);
    expect(parsed.data['csp-report'].disposition).toBe('enforce');
  });

  it('csp-report が無い・オブジェクトでない本文は失敗', () => {
    for (const body of [{}, { report: {} }, { 'csp-report': 'x' }, { 'csp-report': null }, { 'csp-report': [1] }, null, 'x', 1, []]) {
      expect(CspReportBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('line-number が負・文字列なら落として通す (報告を 400 にしない)', () => {
    const parsed = CspReportBodySchema.safeParse({
      'csp-report': {
        'blocked-uri': 'inline',
        'line-number': -1,
        'column-number': '7',
        'status-code': 1.5,
        disposition: 'unknown',
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const report = parsed.data['csp-report'];
    expect(report['line-number']).toBeUndefined();
    expect(report['column-number']).toBeUndefined();
    expect(report['status-code']).toBeUndefined();
    expect(report.disposition).toBeUndefined();
    expect(report['blocked-uri']).toBe('inline');
  });
});

describe('isCspReportContentType', () => {
  it('isCspReportContentType: application/csp-report と application/json (charset つき・大文字) は true、text/plain と null は false', () => {
    expect(isCspReportContentType('application/csp-report')).toBe(true);
    expect(isCspReportContentType('application/json')).toBe(true);
    expect(isCspReportContentType('application/json; charset=utf-8')).toBe(true);
    expect(isCspReportContentType('APPLICATION/CSP-REPORT')).toBe(true);
    expect(isCspReportContentType(' Application/Json ;charset=UTF-8')).toBe(true);
    expect(isCspReportContentType('text/plain')).toBe(false);
    expect(isCspReportContentType('application/reports+json')).toBe(false);
    expect(isCspReportContentType('application/jsonx')).toBe(false);
    expect(isCspReportContentType('')).toBe(false);
    expect(isCspReportContentType(null)).toBe(false);
  });
});

describe('scrubCspReportUri', () => {
  it('scrubCspReportUri: http(s) はクエリ・#・ユーザー名・パスワードを落として origin + パス', () => {
    expect(scrubCspReportUri('https://user:pass@homegohan.example/login?next=%2Fhome&token=abc#frag')).toBe(
      'https://homegohan.example/login',
    );
    expect(scrubCspReportUri('http://localhost:3000/home?x=1')).toBe('http://localhost:3000/home');
    expect(scrubCspReportUri('https://homegohan.example')).toBe('https://homegohan.example/');
  });

  it('scrubCspReportUri: /invite/<token>・/family/promotions/<token>・UUID の区間は [redacted]、representative-transfer のような名前は残る', () => {
    expect(scrubCspReportUri('https://homegohan.example/invite/abcDEF1234567890xyz')).toBe(
      `https://homegohan.example/invite/${CSP_REPORT_REDACTED_SEGMENT}`,
    );
    expect(scrubCspReportUri('https://homegohan.example/family/promotions/Zx9_ab-CDefGhIjKlMn')).toBe(
      `https://homegohan.example/family/promotions/${CSP_REPORT_REDACTED_SEGMENT}`,
    );
    expect(scrubCspReportUri('https://homegohan.example/meals/00000000-0000-4000-8000-000000000001/edit')).toBe(
      `https://homegohan.example/meals/${CSP_REPORT_REDACTED_SEGMENT}/edit`,
    );
    expect(scrubCspReportUri('https://homegohan.example/family/representative-transfer')).toBe(
      'https://homegohan.example/family/representative-transfer',
    );
    // 数字を含んでも 16 文字に届かない区間は残す
    expect(scrubCspReportUri('https://homegohan.example/meals/2026-01-05')).toBe('https://homegohan.example/meals/2026-01-05');
  });

  it('scrubCspReportUri: data: / blob: / chrome-extension: はスキームだけ、inline / eval / self はそのまま、空は null', () => {
    expect(scrubCspReportUri('data:text/javascript,alert(document.cookie)')).toBe('data:');
    expect(scrubCspReportUri('blob:https://homegohan.example/0000-1111')).toBe('blob:');
    expect(scrubCspReportUri('chrome-extension://abcdefghijklmnop/content.js')).toBe('chrome-extension:');
    expect(scrubCspReportUri('inline')).toBe('inline');
    expect(scrubCspReportUri('eval')).toBe('eval');
    expect(scrubCspReportUri('self')).toBe('self');
    expect(scrubCspReportUri('')).toBeNull();
    expect(scrubCspReportUri('   ')).toBeNull();
    expect(scrubCspReportUri(undefined)).toBeNull();
  });
});

describe('toCspViolationLogEntry', () => {
  it('toCspViolationLogEntry: message は "CSP violation: <effective> blocked <blocked>"、metadata は snake_case の 11 キーで original-policy と referrer を含まない', () => {
    const report: CspReport = CspReportBodySchema.parse(CHROME_REPORT)['csp-report'];
    const entry = toCspViolationLogEntry(report, { userAgent: 'Mozilla/5.0 Test' });

    expect(entry.message).toBe('CSP violation: script-src-elem blocked inline');
    expect(entry.metadata).toEqual({
      effective_directive: 'script-src-elem',
      violated_directive: 'script-src-elem',
      blocked_uri: 'inline',
      document_uri: 'https://homegohan.example/login',
      source_file: 'https://homegohan.example/login',
      line_number: 12,
      column_number: 7,
      disposition: 'enforce',
      status_code: 200,
      script_sample: 'alert(1)',
      user_agent: 'Mozilla/5.0 Test',
    });
    expect(Object.keys(entry.metadata)).toHaveLength(11);
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(ORIGINAL_POLICY);
    expect(serialized).not.toContain('original');
    expect(serialized).not.toContain('referrer');

    // effective-directive が無ければ violated-directive、どちらも無ければ unknown。blocked-uri が無ければ unknown
    expect(toCspViolationLogEntry({ 'violated-directive': 'script-src' }, { userAgent: null }).message).toBe(
      'CSP violation: script-src blocked unknown',
    );
    const empty = toCspViolationLogEntry({}, { userAgent: null });
    expect(empty.message).toBe('CSP violation: unknown blocked unknown');
    expect(Object.values(empty.metadata).every((value) => value === null)).toBe(true);
  });

  it('toCspViolationLogEntry: script_sample は 40 文字、user_agent は 256 文字に切る', () => {
    const longSample = 'a'.repeat(CSP_REPORT_SCRIPT_SAMPLE_MAX_CHARS + 10);
    const longAgent = 'u'.repeat(CSP_REPORT_USER_AGENT_MAX_CHARS + 10);
    const entry = toCspViolationLogEntry({ 'script-sample': longSample }, { userAgent: longAgent });

    expect(CSP_REPORT_SCRIPT_SAMPLE_MAX_CHARS).toBe(40);
    expect(CSP_REPORT_USER_AGENT_MAX_CHARS).toBe(256);
    expect(entry.metadata.script_sample).toBe('a'.repeat(40));
    expect(entry.metadata.user_agent).toBe('u'.repeat(256));
    // 上限ちょうどは切らない
    const exact = toCspViolationLogEntry({ 'script-sample': 'b'.repeat(40) }, { userAgent: 'c'.repeat(256) });
    expect(exact.metadata.script_sample).toBe('b'.repeat(40));
    expect(exact.metadata.user_agent).toBe('c'.repeat(256));
  });
});

describe('cspReportByteLength', () => {
  it('cspReportByteLength: UTF-8 のバイト数 (日本語は 3 バイト)', () => {
    expect(cspReportByteLength('')).toBe(0);
    expect(cspReportByteLength('abc')).toBe(3);
    expect(cspReportByteLength('違反')).toBe(6);
    expect(cspReportByteLength('a違')).toBe(4);
  });
});
