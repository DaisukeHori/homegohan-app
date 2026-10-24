/**
 * #1917 運営の route (admin・super-admin・比較の集計の手動実行) の 403 の文: 二段階認証の未完了は二段階認証の文にする
 *
 * 以前は次のようになっていた:
 *   ゲート (requireRole) が二段階認証の未完了 (MfaRequiredError。ForbiddenError の派生) で止めても、多くの運営の route の catch は
 *   ForbiddenError をまとめて固定の「権限がありません」にしていた。ゲートの後でセッションの状態が変わったとき、
 *   二段階認証が要るのに権限が無いように見えた (ロールの変更の route だけが先に二段階認証の文にしていた)。
 *
 * 直したあとの不変条件:
 *   - 下の CASES の route は、MfaRequiredError なら 403・従来の code のまま・その理由の日本語の固定の文
 *     (確認 = 「二段階認証の確認が必要です」・登録 = 「二段階認証の登録が必要です」)。ほかの ForbiddenError は従来どおり「権限がありません」。
 *     どれも例外の文面を本文に出さず、DB に触れない
 *   - 運営の route のファイルで ForbiddenError を拾う箇所は、固定の「権限がありません」を直に書かない (operatorForbiddenMessageOf を通す)。
 *     そのファイルの HTTP の関数はどれも CASES に入っている (あとから足した route の取りこぼしを機械で見つける)
 */
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';
import {
  API_FORBIDDEN_MESSAGE,
  API_MFA_ENROLLMENT_REQUIRED_MESSAGE,
  API_MFA_REQUIRED_MESSAGE,
  API_OP_PERMISSION_DENIED_MESSAGE,
  operatorForbiddenMessageOf,
} from '@/lib/api/error-responses';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// テストの中で route を丸ごと読み込むので、負荷の高い機械で既定の時間切れを超えうる (#1605 の同じ型)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const ID = '30000000-0000-4000-8000-000000000001';
const BASE = 'http://localhost';
/** 例外の文面 (本文に出てはいけない) */
const RAW_MFA_TEXT = 'MFA required (raw)';
const RAW_FORBIDDEN_TEXT = 'Requires one of: super_admin';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  /** DB の client を作った回数 (ゲートで止まったら 0 のまま) */
  dbClients: 0,
}));

vi.mock('@/lib/auth/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/helpers')>()),
  requireRole: h.requireRole,
}));

function untouchableClient(): never {
  h.dbClients += 1;
  throw new Error('ゲートで止まる route が DB の client を作った');
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => untouchableClient(),
  getSupabaseAdmin: () => untouchableClient(),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: vi.fn(() => ({ ...logger, withUser: vi.fn(() => logger) })),
    generateRequestId: vi.fn(() => 'req_test'),
  };
});

vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-test');

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function req(method: Method, url: string): NextRequest {
  if (method === 'GET') return new NextRequest(`${BASE}${url}`);
  return new NextRequest(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

const idCtx = { params: Promise.resolve({ id: ID }) };
const modCtx = { params: Promise.resolve({ type: 'recipe', id: ID }) };

interface Case {
  /** route のファイル (リポジトリの根からの相対) */
  file: string;
  method: Method;
  /** 403 の code (従来のまま) */
  code: string;
  /** 二段階認証でない 403 の文 (従来のまま)。省略すると「権限がありません」 */
  deniedMessage?: string;
  call: () => Promise<Response>;
}

const OP = 'OP_PERMISSION_DENIED';

const CASES: Case[] = [
  { file: 'src/app/api/admin/catalog/import/route.ts', method: 'POST', code: OP, call: async () => (await import('@/app/api/admin/catalog/import/route')).POST(req('POST', '/api/admin/catalog/import')) },
  { file: 'src/app/api/admin/finance/exports/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/admin/finance/exports/route')).GET(req('GET', '/api/admin/finance/exports')) },
  // POST は以前から authFailureNested (既定の表) を通すので、二段階認証でない 403 の文は「この操作を行う権限がありません」
  { file: 'src/app/api/admin/finance/exports/route.ts', method: 'POST', code: OP, deniedMessage: API_FORBIDDEN_MESSAGE, call: async () => (await import('@/app/api/admin/finance/exports/route')).POST(req('POST', '/api/admin/finance/exports')) },
  { file: 'src/app/api/admin/finance/refunds/route.ts', method: 'POST', code: OP, call: async () => (await import('@/app/api/admin/finance/refunds/route')).POST(req('POST', '/api/admin/finance/refunds')) },
  { file: 'src/app/api/admin/moderation/[type]/[id]/restore/route.ts', method: 'POST', code: OP, call: async () => (await import('@/app/api/admin/moderation/[type]/[id]/restore/route')).POST(req('POST', `/api/admin/moderation/recipe/${ID}/restore`), modCtx) },
  { file: 'src/app/api/admin/moderation/[type]/[id]/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/admin/moderation/[type]/[id]/route')).GET(req('GET', `/api/admin/moderation/recipe/${ID}`), modCtx) },
  { file: 'src/app/api/admin/moderation/[type]/[id]/route.ts', method: 'POST', code: OP, call: async () => (await import('@/app/api/admin/moderation/[type]/[id]/route')).POST(req('POST', `/api/admin/moderation/recipe/${ID}`), modCtx) },
  { file: 'src/app/api/admin/moderation/[type]/[id]/route.ts', method: 'PUT', code: OP, call: async () => (await import('@/app/api/admin/moderation/[type]/[id]/route')).PUT(req('PUT', `/api/admin/moderation/recipe/${ID}`), modCtx) },
  { file: 'src/app/api/admin/moderation/queue/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/admin/moderation/queue/route')).GET(req('GET', '/api/admin/moderation/queue')) },
  { file: 'src/app/api/admin/moderation/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/admin/moderation/route')).GET(req('GET', '/api/admin/moderation')) },
  { file: 'src/app/api/admin/organizations/[id]/route.ts', method: 'PATCH', code: OP, call: async () => (await import('@/app/api/admin/organizations/[id]/route')).PATCH(req('PATCH', `/api/admin/organizations/${ID}`), idCtx) },
  { file: 'src/app/api/admin/organizations/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/admin/organizations/route')).GET(req('GET', '/api/admin/organizations')) },
  { file: 'src/app/api/admin/organizations/route.ts', method: 'POST', code: OP, call: async () => (await import('@/app/api/admin/organizations/route')).POST(req('POST', '/api/admin/organizations')) },
  { file: 'src/app/api/admin/users/[id]/freeze/route.ts', method: 'POST', code: OP, call: async () => (await import('@/app/api/admin/users/[id]/freeze/route')).POST(req('POST', `/api/admin/users/${ID}/freeze`), idCtx) },
  { file: 'src/app/api/admin/users/[id]/freeze/route.ts', method: 'DELETE', code: OP, call: async () => (await import('@/app/api/admin/users/[id]/freeze/route')).DELETE(req('DELETE', `/api/admin/users/${ID}/freeze`), idCtx) },
  { file: 'src/app/api/admin/users/[id]/login-history/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/admin/users/[id]/login-history/route')).GET(req('GET', `/api/admin/users/${ID}/login-history`), idCtx) },
  { file: 'src/app/api/admin/users/[id]/role/route.ts', method: 'PATCH', code: OP, call: async () => (await import('@/app/api/admin/users/[id]/role/route')).PATCH(req('PATCH', `/api/admin/users/${ID}/role`), idCtx) },
  { file: 'src/app/api/admin/users/[id]/role/route.ts', method: 'PUT', code: OP, call: async () => (await import('@/app/api/admin/users/[id]/role/route')).PUT(req('PUT', `/api/admin/users/${ID}/role`), idCtx) },
  { file: 'src/app/api/admin/users/[id]/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/admin/users/[id]/route')).GET(req('GET', `/api/admin/users/${ID}`), idCtx) },
  { file: 'src/app/api/admin/users/[id]/route.ts', method: 'PATCH', code: OP, call: async () => (await import('@/app/api/admin/users/[id]/route')).PATCH(req('PATCH', `/api/admin/users/${ID}`), idCtx) },
  { file: 'src/app/api/admin/users/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/admin/users/route')).GET(req('GET', '/api/admin/users')) },
  // 問い合わせ・本人の権利の請求の運営の route は src/lib/admin/inquiries.ts の authFailureResponse を通す
  { file: 'src/app/api/admin/inquiries/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/admin/inquiries/route')).GET(req('GET', '/api/admin/inquiries')) },
  { file: 'src/app/api/admin/inquiries/[id]/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/admin/inquiries/[id]/route')).GET(req('GET', `/api/admin/inquiries/${ID}`), idCtx) },
  { file: 'src/app/api/admin/inquiries/[id]/route.ts', method: 'PATCH', code: OP, call: async () => (await import('@/app/api/admin/inquiries/[id]/route')).PATCH(req('PATCH', `/api/admin/inquiries/${ID}`), idCtx) },
  { file: 'src/app/api/admin/inquiries/[id]/route.ts', method: 'PUT', code: OP, call: async () => (await import('@/app/api/admin/inquiries/[id]/route')).PUT(req('PUT', `/api/admin/inquiries/${ID}`), idCtx) },
  { file: 'src/app/api/admin/data-requests/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/admin/data-requests/route')).GET(req('GET', '/api/admin/data-requests')) },
  { file: 'src/app/api/admin/data-requests/[id]/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/admin/data-requests/[id]/route')).GET(req('GET', `/api/admin/data-requests/${ID}`), idCtx) },
  { file: 'src/app/api/admin/data-requests/[id]/route.ts', method: 'PATCH', code: OP, call: async () => (await import('@/app/api/admin/data-requests/[id]/route')).PATCH(req('PATCH', `/api/admin/data-requests/${ID}`), idCtx) },
  // 比較の集計の手動実行 (super_admin だけ)。403 の code は従来の FORBIDDEN のまま
  { file: 'src/app/api/comparison/trigger/route.ts', method: 'POST', code: 'FORBIDDEN', call: async () => (await import('@/app/api/comparison/trigger/route')).POST(req('POST', '/api/comparison/trigger')) },
  { file: 'src/app/api/super-admin/coupons/[id]/apply/route.ts', method: 'POST', code: OP, call: async () => (await import('@/app/api/super-admin/coupons/[id]/apply/route')).POST(req('POST', `/api/super-admin/coupons/${ID}/apply`), idCtx) },
  { file: 'src/app/api/super-admin/coupons/[id]/redemptions/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/super-admin/coupons/[id]/redemptions/route')).GET(req('GET', `/api/super-admin/coupons/${ID}/redemptions`), idCtx) },
  { file: 'src/app/api/super-admin/coupons/[id]/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/super-admin/coupons/[id]/route')).GET(req('GET', `/api/super-admin/coupons/${ID}`), idCtx) },
  { file: 'src/app/api/super-admin/coupons/[id]/route.ts', method: 'PATCH', code: OP, call: async () => (await import('@/app/api/super-admin/coupons/[id]/route')).PATCH(req('PATCH', `/api/super-admin/coupons/${ID}`), idCtx) },
  { file: 'src/app/api/super-admin/coupons/[id]/route.ts', method: 'DELETE', code: OP, call: async () => (await import('@/app/api/super-admin/coupons/[id]/route')).DELETE(req('DELETE', `/api/super-admin/coupons/${ID}`), idCtx) },
  { file: 'src/app/api/super-admin/coupons/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/super-admin/coupons/route')).GET(req('GET', '/api/super-admin/coupons')) },
  { file: 'src/app/api/super-admin/coupons/route.ts', method: 'POST', code: OP, call: async () => (await import('@/app/api/super-admin/coupons/route')).POST(req('POST', '/api/super-admin/coupons')) },
  { file: 'src/app/api/super-admin/feature-packages/[id]/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/super-admin/feature-packages/[id]/route')).GET(req('GET', `/api/super-admin/feature-packages/${ID}`), idCtx) },
  { file: 'src/app/api/super-admin/feature-packages/[id]/route.ts', method: 'PATCH', code: OP, call: async () => (await import('@/app/api/super-admin/feature-packages/[id]/route')).PATCH(req('PATCH', `/api/super-admin/feature-packages/${ID}`), idCtx) },
  { file: 'src/app/api/super-admin/feature-packages/[id]/route.ts', method: 'DELETE', code: OP, call: async () => (await import('@/app/api/super-admin/feature-packages/[id]/route')).DELETE(req('DELETE', `/api/super-admin/feature-packages/${ID}`), idCtx) },
  { file: 'src/app/api/super-admin/feature-packages/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/super-admin/feature-packages/route')).GET(req('GET', '/api/super-admin/feature-packages')) },
  { file: 'src/app/api/super-admin/feature-packages/route.ts', method: 'POST', code: OP, call: async () => (await import('@/app/api/super-admin/feature-packages/route')).POST(req('POST', '/api/super-admin/feature-packages')) },
  { file: 'src/app/api/super-admin/plans/[id]/price-change/route.ts', method: 'POST', code: OP, call: async () => (await import('@/app/api/super-admin/plans/[id]/price-change/route')).POST(req('POST', `/api/super-admin/plans/${ID}/price-change`), idCtx) },
  { file: 'src/app/api/super-admin/plans/[id]/price-impact/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/super-admin/plans/[id]/price-impact/route')).GET(req('GET', `/api/super-admin/plans/${ID}/price-impact`), idCtx) },
  { file: 'src/app/api/super-admin/plans/[id]/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/super-admin/plans/[id]/route')).GET(req('GET', `/api/super-admin/plans/${ID}`), idCtx) },
  { file: 'src/app/api/super-admin/plans/[id]/route.ts', method: 'PATCH', code: OP, call: async () => (await import('@/app/api/super-admin/plans/[id]/route')).PATCH(req('PATCH', `/api/super-admin/plans/${ID}`), idCtx) },
  { file: 'src/app/api/super-admin/plans/[id]/route.ts', method: 'DELETE', code: OP, call: async () => (await import('@/app/api/super-admin/plans/[id]/route')).DELETE(req('DELETE', `/api/super-admin/plans/${ID}`), idCtx) },
  { file: 'src/app/api/super-admin/plans/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/super-admin/plans/route')).GET(req('GET', '/api/super-admin/plans')) },
  { file: 'src/app/api/super-admin/plans/route.ts', method: 'POST', code: OP, call: async () => (await import('@/app/api/super-admin/plans/route')).POST(req('POST', '/api/super-admin/plans')) },
  { file: 'src/app/api/super-admin/users/[id]/manual-plan/route.ts', method: 'GET', code: OP, call: async () => (await import('@/app/api/super-admin/users/[id]/manual-plan/route')).GET(req('GET', `/api/super-admin/users/${ID}/manual-plan`), idCtx) },
  { file: 'src/app/api/super-admin/users/[id]/manual-plan/route.ts', method: 'POST', code: OP, call: async () => (await import('@/app/api/super-admin/users/[id]/manual-plan/route')).POST(req('POST', `/api/super-admin/users/${ID}/manual-plan`), idCtx) },
  { file: 'src/app/api/super-admin/users/[id]/manual-plan/route.ts', method: 'DELETE', code: OP, call: async () => (await import('@/app/api/super-admin/users/[id]/manual-plan/route')).DELETE(req('DELETE', `/api/super-admin/users/${ID}/manual-plan`), idCtx) },
];

const caseName = (c: Case) => `${c.method} ${c.file}`;

const GATE_ERRORS = [
  ['二段階認証の確認 (AUTH_2FA_REQUIRED)', () => new MfaRequiredError('AUTH_2FA_REQUIRED', RAW_MFA_TEXT), API_MFA_REQUIRED_MESSAGE],
  ['二段階認証の登録 (AUTH_2FA_ENROLLMENT_REQUIRED)', () => new MfaRequiredError('AUTH_2FA_ENROLLMENT_REQUIRED', RAW_MFA_TEXT), API_MFA_ENROLLMENT_REQUIRED_MESSAGE],
  /** 文が null = その route の従来の二段階認証でない 403 の文 (Case.deniedMessage) */
  ['ロールが足りない (PERM_DENIED)', () => new ForbiddenError('PERM_DENIED', RAW_FORBIDDEN_TEXT), null],
] as const;

beforeEach(() => {
  h.requireRole.mockReset();
  h.dbClients = 0;
});

describe('operatorForbiddenMessageOf (#1917)', () => {
  it('MfaRequiredError は理由の日本語の文、ほかの ForbiddenError (凍結を含む) は従来の「権限がありません」', () => {
    expect(operatorForbiddenMessageOf(new MfaRequiredError('AUTH_2FA_REQUIRED', RAW_MFA_TEXT))).toBe(API_MFA_REQUIRED_MESSAGE);
    expect(operatorForbiddenMessageOf(new MfaRequiredError('AUTH_2FA_ENROLLMENT_REQUIRED'))).toBe(API_MFA_ENROLLMENT_REQUIRED_MESSAGE);
    expect(operatorForbiddenMessageOf(new ForbiddenError('PERM_DENIED', RAW_FORBIDDEN_TEXT))).toBe('権限がありません');
    expect(operatorForbiddenMessageOf(new ForbiddenError('AUTH_ACCOUNT_FROZEN'))).toBe('権限がありません');
    // MfaRequiredError でない ForbiddenError が二段階認証の code を持っていても、運営の route の従来の文のまま (型で決める)
    expect(operatorForbiddenMessageOf(new ForbiddenError('AUTH_2FA_REQUIRED'))).toBe('権限がありません');
    expect(API_OP_PERMISSION_DENIED_MESSAGE).toBe('権限がありません');
  });
});

describe.each(CASES.map((c) => [caseName(c), c] as const))('%s: ゲートの 403 の文 (#1917)', (_name, c) => {
  it.each(GATE_ERRORS)('%s: 403・従来の code・理由の日本語の固定の文で、例外の文面を出さず DB に触れない', async (_label, makeError, message) => {
    h.requireRole.mockRejectedValue(makeError());
    const res = await c.call();
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: c.code, message: message ?? c.deniedMessage ?? API_OP_PERMISSION_DENIED_MESSAGE } });
    expect(text).not.toContain(RAW_MFA_TEXT);
    expect(text).not.toContain(RAW_FORBIDDEN_TEXT);
    expect(h.requireRole).toHaveBeenCalledTimes(1);
    expect(h.dbClients).toBe(0);
  });

  it('未ログイン (AuthError) は 401 のまま (403 の直しで 401 を変えない)', async () => {
    h.requireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));
    const res = await c.call();
    expect(res.status).toBe(401);
    expect(h.dbClients).toBe(0);
  });
});

/** 運営の route を探す範囲 */
const OPERATOR_ROUTE_DIRS = ['src/app/api/admin', 'src/app/api/super-admin', 'src/app/api/comparison'];
/** route のファイルでない、ForbiddenError を運営の 403 にする共通の関数のファイル */
const OPERATOR_SHARED_FILES = ['src/lib/admin/inquiries.ts'];
/** ForbiddenError を拾う箇所から、この行数のうちに固定の文を直に書いていたら見つける (従来の書き方は 1〜2 行あと) */
const FORBIDDEN_BRANCH_WINDOW_LINES = 5;
const HTTP_METHOD_EXPORT = /^export (?:async function|const) (GET|POST|PUT|PATCH|DELETE)\b/gm;

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walkRoutes(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) return walkRoutes(rel);
    return e.name === 'route.ts' ? [rel] : [];
  });
}

/** ForbiddenError を拾う箇所のあとに、固定の「権限がありません」を直に書いている行 (file:line) */
function fixedForbiddenMessages(rel: string, text: string): string[] {
  const lines = text.split('\n');
  const found: string[] = [];
  lines.forEach((line, i) => {
    if (!/instanceof ForbiddenError/.test(line)) return;
    for (let j = i; j < Math.min(i + FORBIDDEN_BRANCH_WINDOW_LINES, lines.length); j += 1) {
      if (lines[j].includes("'権限がありません'")) found.push(`${rel}:${j + 1}`);
    }
  });
  return found;
}

describe('運営の route の ForbiddenError を拾う箇所 (#1917)', () => {
  const operatorRoutes = OPERATOR_ROUTE_DIRS.flatMap(walkRoutes);
  const catching = operatorRoutes.filter((rel) => /instanceof ForbiddenError/.test(read(rel)));
  const sharedUsers = operatorRoutes.filter((rel) => /\bauthFailureResponse\(/.test(read(rel)));

  it('探す範囲に route があり、ForbiddenError を拾う route がある (走査が空振りしていない)', () => {
    expect(operatorRoutes.length).toBeGreaterThan(0);
    expect(catching).toContain('src/app/api/admin/users/[id]/freeze/route.ts');
    expect(sharedUsers).toContain('src/app/api/admin/inquiries/route.ts');
  });

  it('固定の「権限がありません」を直に書かない (operatorForbiddenMessageOf を通す)', () => {
    const offenders = [...catching, ...OPERATOR_SHARED_FILES].flatMap((rel) => fixedForbiddenMessages(rel, read(rel)));
    expect(offenders).toEqual([]);
  });

  it('見張りは、直に書いた固定の文を見つける', () => {
    const before = "  } catch (err) {\n    if (err instanceof ForbiddenError) {\n      return NextResponse.json(\n        { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } },\n";
    expect(fixedForbiddenMessages('x.ts', before)).toEqual(['x.ts:4']);
    const after = before.replace("'権限がありません'", 'operatorForbiddenMessageOf(err)');
    expect(fixedForbiddenMessages('x.ts', after)).toEqual([]);
  });

  it('ForbiddenError を拾う route・共通の関数を使う route の HTTP の関数は、どれも上の CASES で確かめている', () => {
    const covered = new Set(CASES.map(caseName));
    const missing = [...new Set([...catching, ...sharedUsers])].flatMap((rel) =>
      [...read(rel).matchAll(HTTP_METHOD_EXPORT)].map((m) => `${m[1]} ${rel}`).filter((name) => !covered.has(name)),
    );
    expect(missing).toEqual([]);
  });
});
