// src/lib/security/csp-report.ts
// #1169 違反の報告 (report-uri が送る application/csp-report) の形・上限・app_logs に残す形。route (src/app/api/csp-report/route.ts) はこれだけを呼ぶ。
import { z } from 'zod';

/** 受け付ける Content-Type (ブラウザは application/csp-report。curl やテストは application/json も可)。media type の部分だけを小文字で比べる */
export const CSP_REPORT_CONTENT_TYPES = ['application/csp-report', 'application/json'] as const;
/** 本文の上限 (バイト)。実際の報告は original-policy (約 700 バイト) を含めて 1〜2 KB。余裕を見つつ、大きな本文で CPU を使わせない */
export const CSP_REPORT_MAX_BYTES = 8 * 1024;
/** 保存する URL (document_uri / blocked_uri / source_file) の上限 (文字) */
export const CSP_REPORT_URI_MAX_CHARS = 2048;
/** 保存するディレクティブ名の上限 (文字) */
export const CSP_REPORT_DIRECTIVE_MAX_CHARS = 256;
/** 'report-sample' がブラウザに載せるインラインの先頭の文字数 (CSP3 の定め)。それより長い値も切る */
export const CSP_REPORT_SCRIPT_SAMPLE_MAX_CHARS = 40;
/** 保存する User-Agent の上限 (文字) */
export const CSP_REPORT_USER_AGENT_MAX_CHARS = 256;
/** URL のパスの区間を「トークンらしい」とみなす最小の長さ (招待トークン・UUID は 16 文字以上。画面の名前は短いか数字を含まない) */
export const CSP_REPORT_TOKEN_SEGMENT_MIN_CHARS = 16;
/** トークンらしい区間の置き換え */
export const CSP_REPORT_REDACTED_SEGMENT = '[redacted]';
/** app_logs の function_name (運営の画面 /super-admin/logs で絞る語)。createLogger に渡す */
export const CSP_REPORT_LOG_FUNCTION_NAME = 'csp-report';

/** 4xx の本文の code (cross/04 §4.2 に [NEW] で足す) */
export const CSP_REPORT_ERROR_CODES = {
  invalid: 'CSP_REPORT_INVALID',
  tooLarge: 'CSP_REPORT_TOO_LARGE',
  unsupportedMediaType: 'CSP_REPORT_UNSUPPORTED_MEDIA_TYPE',
} as const;

/** 0 以上の整数。数値でない・負の値は undefined にして落とす (報告を 400 にしない) */
const optionalCount = z.number().int().nonnegative().optional().catch(undefined);

/**
 * application/csp-report の本文 { "csp-report": {…} }。知らないキーは捨てる (zod の既定)。
 * 文字列の長さはここでは縛らない (本文全体の上限 CSP_REPORT_MAX_BYTES で抑え、保存時に切る)。報告を落とさないため
 */
export const CspReportSchema = z.object({
  'document-uri': z.string().optional(),
  referrer: z.string().optional(),
  'blocked-uri': z.string().optional(),
  'effective-directive': z.string().optional(),
  'violated-directive': z.string().optional(),
  'original-policy': z.string().optional(),
  disposition: z.enum(['enforce', 'report']).optional().catch(undefined),
  'source-file': z.string().optional(),
  'line-number': optionalCount,
  'column-number': optionalCount,
  'status-code': optionalCount,
  'script-sample': z.string().optional(),
});
export const CspReportBodySchema = z.object({ 'csp-report': CspReportSchema });
export type CspReport = z.infer<typeof CspReportSchema>;
export type CspReportBody = z.infer<typeof CspReportBodySchema>;

/** app_logs の metadata (snake_case)。null は報告に無かった項目 */
export type CspViolationLogMetadata = {
  effective_directive: string | null;
  violated_directive: string | null;
  blocked_uri: string | null;
  document_uri: string | null;
  source_file: string | null;
  line_number: number | null;
  column_number: number | null;
  disposition: 'enforce' | 'report' | null;
  status_code: number | null;
  script_sample: string | null;
  user_agent: string | null;
};

export interface CspViolationLogEntry {
  message: string;
  metadata: CspViolationLogMetadata;
}

export interface CspViolationLogContext {
  /** リクエストの User-Agent (無ければ null) */
  userAgent: string | null;
}

/** Content-Type が受け付ける種類か (パラメータ `; charset=…` は無視。大文字小文字は区別しない) */
export function isCspReportContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  return (CSP_REPORT_CONTENT_TYPES as readonly string[]).includes(mediaType);
}

/** 本文のバイト数 (UTF-8)。Content-Length を信じず、読んだ本文で数える */
export function cspReportByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/** 招待トークン・UUID のような区間か (16 文字以上・英数字と _ - だけ・数字を含む)。画面の名前 (representative-transfer など) は数字を含まないので当たらない */
function isTokenLikeSegment(segment: string): boolean {
  return (
    segment.length >= CSP_REPORT_TOKEN_SEGMENT_MIN_CHARS && /^[A-Za-z0-9_-]+$/.test(segment) && /[0-9]/.test(segment)
  );
}

/** パスのトークンらしい区間を [redacted] にする (/invite/<token>・/family/promotions/<token>・/meals/<uuid> などを残さない) */
export function maskTokenLikeSegments(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (isTokenLikeSegment(segment) ? CSP_REPORT_REDACTED_SEGMENT : segment))
    .join('/');
}

/**
 * 報告の URL を保存できる形にする。
 *   - http(s) の URL: origin + パス (クエリ・#・ユーザー名・パスワードを落とし、トークンらしい区間を [redacted] に)
 *   - それ以外の URL (data: / blob: / chrome-extension: / about: など): スキームだけ (中身に攻撃の本文が入りうる)
 *   - URL でない値 (CSP の語 inline / eval / self / data など): そのまま (上限まで)
 *   - 無い・空: null
 */
export function scrubCspReportUri(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return truncate(trimmed, CSP_REPORT_URI_MAX_CHARS);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return parsed.protocol;
  return truncate(`${parsed.origin}${maskTokenLikeSegments(parsed.pathname)}`, CSP_REPORT_URI_MAX_CHARS);
}

/** 報告 1 件を app_logs の 1 行 (message + metadata) にする。original-policy と referrer は残さない。利用者は特定しない */
export function toCspViolationLogEntry(report: CspReport, context: CspViolationLogContext): CspViolationLogEntry {
  const effectiveDirective = report['effective-directive'] ? truncate(report['effective-directive'], CSP_REPORT_DIRECTIVE_MAX_CHARS) : null;
  const violatedDirective = report['violated-directive'] ? truncate(report['violated-directive'], CSP_REPORT_DIRECTIVE_MAX_CHARS) : null;
  const blockedUri = scrubCspReportUri(report['blocked-uri']);
  const metadata: CspViolationLogMetadata = {
    effective_directive: effectiveDirective,
    violated_directive: violatedDirective,
    blocked_uri: blockedUri,
    document_uri: scrubCspReportUri(report['document-uri']),
    source_file: scrubCspReportUri(report['source-file']),
    line_number: report['line-number'] ?? null,
    column_number: report['column-number'] ?? null,
    disposition: report.disposition ?? null,
    status_code: report['status-code'] ?? null,
    script_sample: report['script-sample'] ? truncate(report['script-sample'], CSP_REPORT_SCRIPT_SAMPLE_MAX_CHARS) : null,
    user_agent: context.userAgent ? truncate(context.userAgent, CSP_REPORT_USER_AGENT_MAX_CHARS) : null,
  };
  return {
    message: `CSP violation: ${effectiveDirective ?? violatedDirective ?? 'unknown'} blocked ${blockedUri ?? 'unknown'}`,
    metadata,
  };
}
