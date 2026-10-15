// src/app/api/csp-report/route.ts
/**
 * CSP の違反の報告の受け口 (#1169)。ブラウザが方針の report-uri へ application/csp-report で POST する。
 * 未認証 (報告はセッションの有無によらず届く)。守りは IP ごとの回数制限 (csp-report) と本文の上限。
 * 通った報告だけを app_logs に warn で残す (運営は /super-admin/logs で function_name = csp-report で絞る)。
 * 4xx はどれも app_logs に書かない (偽の報告で表を膨らませない)。本文に生のエラー文・環境変数名を入れない。
 */
import { NextRequest, NextResponse } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { internalError } from '@/lib/api/errors';
import { createLogger } from '@/lib/db-logger';
import { checkRateLimit, rateLimitExceededResponse, type RateLimitResult } from '@/lib/rate-limit';
import {
  CSP_REPORT_ERROR_CODES,
  CSP_REPORT_LOG_FUNCTION_NAME,
  CSP_REPORT_MAX_BYTES,
  CspReportBodySchema,
  cspReportByteLength,
  isCspReportContentType,
  toCspViolationLogEntry,
} from '@/lib/security/csp-report';

const ROUTE_NAME = 'POST /api/csp-report';
/** 受け付けたときの応答 (本文無し。ブラウザは応答を読まない) */
const ACCEPTED_STATUS = 204;
/** 4xx の本文の文 (固定) */
const INVALID_REPORT_MESSAGE = '報告の形が不正です';

function badRequest(status: 400 | 413 | 415, code: string): NextResponse {
  return NextResponse.json({ error: INVALID_REPORT_MESSAGE, code }, { status });
}

/** ログイン前の公開 API と同じく、プロキシが付けるクライアント IP を回数制限の key にする (src/app/api/contact/route.ts と同じ取り方) */
function clientIpOf(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown';
}

export async function POST(request: NextRequest) {
  // 本文の NULL 文字は入口で 400 (#1657。一覧は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;

  let rateLimit: RateLimitResult;
  try {
    rateLimit = await checkRateLimit(clientIpOf(request), 'csp-report');
  } catch (error) {
    // Upstash への問い合わせが例外: fail-closed (判定できないなら通さない。contact と同じ)
    return internalError(ROUTE_NAME, error);
  }
  if (!rateLimit.success) return rateLimitExceededResponse(rateLimit);

  if (!isCspReportContentType(request.headers.get('content-type'))) {
    return badRequest(415, CSP_REPORT_ERROR_CODES.unsupportedMediaType);
  }
  const text = await request.text();
  if (cspReportByteLength(text) > CSP_REPORT_MAX_BYTES) return badRequest(413, CSP_REPORT_ERROR_CODES.tooLarge);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return badRequest(400, CSP_REPORT_ERROR_CODES.invalid);
  }
  const parsed = CspReportBodySchema.safeParse(json);
  if (!parsed.success) return badRequest(400, CSP_REPORT_ERROR_CODES.invalid);

  const entry = toCspViolationLogEntry(parsed.data['csp-report'], { userAgent: request.headers.get('user-agent') });
  // 保存は待たない (createLogger は console に出し、app_logs への insert は非同期)。応答は常に 204
  createLogger(CSP_REPORT_LOG_FUNCTION_NAME).warn(entry.message, entry.metadata);
  return new NextResponse(null, { status: ACCEPTED_STATUS });
}
