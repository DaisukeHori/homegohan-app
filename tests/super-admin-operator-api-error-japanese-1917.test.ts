// @vitest-environment node
/**
 * #1917 super_admin・運営の操作の API (src/app/api/super-admin/** と src/app/api/operator/**) の失敗の本文の日本語化
 *
 * 問題:
 *   運営の画面 (src/app/super-admin・src/app/(operator)) は API の失敗の本文の `error.message` をそのまま出す。
 *   route が requireRole の例外の文面 ('Requires one of: super_admin' など) や Zod の既定の英語の文
 *   ('Invalid input: expected number, received string' など)・Edge Function の英語の文を本文に入れると、失敗したときだけ英語が出る。
 *
 * このテストが確かめること:
 *   1. 直し終えた配下のどの handler も、認可の失敗 (401 / 403) の本文に例外の文面を入れず、日本語の文を返す
 *      (route を全部読み込んで、requireRole を英語の文面つきの例外で落として確かめる。走査の見張りが見ない関数の引数の形も含む)
 *   2. 直し終えた配下の route のソースに、エラーの `.message` を本文に渡す形 (ログ・new Error の引数を除く) が無い
 *   3. super-admin の 400 (validation-errors.ts) は、Zod の既定の英語の文を日本語の固定の文 + 項目の名前にし、schema の日本語の文はそのまま
 *   4. クーポンの適用の業務エラーの文は、業務エラーの表の日本語の固定の文だけ
 */
import path from 'node:path';
import ts from 'typescript';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { API_FORBIDDEN_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import {
  SUPER_ADMIN_INVALID_INPUT_FALLBACK_MESSAGE,
  SUPER_ADMIN_INVALID_QUERY_FALLBACK_MESSAGE,
  invalidInputBody,
  invalidQueryBody,
  validationMessageOf,
} from '@/lib/super-admin/validation-errors';
import { COUPON_APPLY_FAILED_MESSAGE, CouponApplyError, couponApplyErrorMessageOf } from '@/lib/plan/coupon';
import { REPO_ROOT, isEnglishOnly, isUnderDir, routeFilesUnder, sourceOf } from './helpers/api-error-text-scan';
import { JAPANESE_ERROR_API_DIRS } from './helpers/api-error-japanese-scope';
import { resolveHeavyUnitTimeouts } from './helpers/heavy-unit-test-timeout';

const requireRole = vi.hoisted(() => vi.fn());
/** 認可より前に DB に触れたら分かるように、Supabase の client を作ったら記録して投げる */
const dbTouched = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/helpers')>()),
  requireRole,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    dbTouched();
    throw new Error('認可より前に Supabase の client を作った');
  },
  getSupabaseAdmin: () => {
    dbTouched();
    throw new Error('認可より前にサービスロールの client を作った');
  },
}));

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
/** requireRole が投げる例外の英語の文面 (src/lib/auth/helpers.ts の形) */
const ENGLISH_UNAUTHENTICATED_DETAIL = 'Not authenticated';
const ENGLISH_ROLE_DETAIL = 'Requires one of: super_admin';
/** パスの [id] / [key] に入れる値 */
const ROUTE_ID = '123e4567-e89b-12d3-a456-426614174000';
const ROUTE_KEY = 'some_flag';
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/** 受け持つ route をすべて読み込むフックの時間切れ (30 本あまりの route の初回の変換を含む。tests/helpers/heavy-unit-test-timeout.ts の値・環境変数で上書き可) */
const ROUTE_IMPORT_HOOK_TIMEOUT_MS = resolveHeavyUnitTimeouts(process.env).hookTimeout;

/** このテストが受け持つ配下 (super-admin と operator のうち、直し終えた配下) */
const OWN_ROOTS = ['src/app/api/super-admin', 'src/app/api/operator'];
/** 受け持つ route の例 (super-admin と operator の両方) */
const SAMPLE_OWN_ROUTES = ['src/app/api/super-admin/llm/quotas/route.ts', 'src/app/api/operator/membership/orgs/inactive/route.ts'];
/** 別の PR が直している途中で、受け持たない譲渡の route */
const TRANSFER_ROUTES = [
  'src/app/api/operator/membership/org/[id]/transfer/route.ts',
  'src/app/api/operator/membership/family/[id]/transfer/route.ts',
];
const OWN_DIRS = JAPANESE_ERROR_API_DIRS.filter((dir) => OWN_ROOTS.some((root) => dir === root || isUnderDir(dir, root)));
const OWN_ROUTE_FILES = OWN_ROOTS.flatMap((root) => routeFilesUnder(root)).filter((file) =>
  OWN_DIRS.some((dir) => isUnderDir(file, dir)),
);

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

interface HandlerCase {
  label: string;
  method: (typeof HTTP_METHODS)[number];
  handler: Handler;
  url: string;
}

function urlOf(file: string): string {
  const routePath = file
    .replace(/^src\/app/, '')
    .replace(/\/route\.ts$/, '')
    .replace('[id]', ROUTE_ID)
    .replace('[key]', ROUTE_KEY);
  return `http://localhost${routePath}`;
}

function requestOf(c: HandlerCase): NextRequest {
  if (c.method === 'GET' || c.method === 'DELETE') return new NextRequest(c.url, { method: c.method });
  return new NextRequest(c.url, { method: c.method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

/** nested は error.message・flat は error の文 */
function messageOf(body: unknown): { code: string | null; message: string } {
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return { code: null, message: error };
  const nested = error as { code?: unknown; message?: unknown } | undefined;
  return { code: typeof nested?.code === 'string' ? nested.code : null, message: String(nested?.message) };
}

const cases: HandlerCase[] = [];

beforeAll(async () => {
  for (const file of OWN_ROUTE_FILES) {
    const mod = (await import(path.join(REPO_ROOT, file))) as Partial<Record<(typeof HTTP_METHODS)[number], Handler>>;
    for (const method of HTTP_METHODS) {
      const handler = mod[method];
      if (handler) cases.push({ label: `${method} ${file}`, method, handler, url: urlOf(file) });
    }
  }
}, ROUTE_IMPORT_HOOK_TIMEOUT_MS);

beforeEach(() => {
  requireRole.mockReset();
  dbTouched.mockReset();
});

describe('直し終えた super-admin・operator の配下の route', () => {
  it('受け持つ配下に route がある (super-admin と operator の両方)', () => {
    expect(OWN_DIRS).toContain('src/app/api/super-admin');
    expect(OWN_DIRS.some((dir) => isUnderDir(dir, 'src/app/api/operator'))).toBe(true);
    for (const file of SAMPLE_OWN_ROUTES) expect(OWN_ROUTE_FILES).toContain(file);
    // 別の PR が直している途中の譲渡の route は受け持たない
    for (const file of TRANSFER_ROUTES) expect(OWN_ROUTE_FILES).not.toContain(file);
  });

  it('どの handler も、未ログイン (英語の文面の AuthError) を 401 の日本語の文で返し、例外の文面を本文に入れない', async () => {
    // どの route.ts も handler を 1 つ以上持つ
    expect(cases.length).toBeGreaterThanOrEqual(OWN_ROUTE_FILES.length);
    const failures: string[] = [];
    for (const c of cases) {
      requireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED', ENGLISH_UNAUTHENTICATED_DETAIL));
      const res = await c.handler(requestOf(c), { params: Promise.resolve({ id: ROUTE_ID, key: ROUTE_KEY }) });
      const text = await res.text();
      const { code, message } = messageOf(JSON.parse(text));
      if (res.status !== HTTP_UNAUTHORIZED) failures.push(`${c.label}: status ${res.status}`);
      if (text.includes(ENGLISH_UNAUTHENTICATED_DETAIL)) failures.push(`${c.label}: 例外の文面が本文にある`);
      if (isEnglishOnly(message) || message === 'undefined') failures.push(`${c.label}: 文が日本語でない「${message}」`);
      // authFailureNested に置き換えた route (code が UNAUTHORIZED) は共通の固定の文
      if (code === 'UNAUTHORIZED' && message !== API_UNAUTHENTICATED_MESSAGE) failures.push(`${c.label}: 「${message}」`);
    }
    expect(failures).toEqual([]);
    expect(dbTouched).not.toHaveBeenCalled();
  });

  it('どの handler も、権限が足りない (英語の文面の ForbiddenError) を 403 の日本語の文で返し、例外の文面を本文に入れない', async () => {
    const failures: string[] = [];
    for (const c of cases) {
      requireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED', ENGLISH_ROLE_DETAIL));
      const res = await c.handler(requestOf(c), { params: Promise.resolve({ id: ROUTE_ID, key: ROUTE_KEY }) });
      const text = await res.text();
      const { code, message } = messageOf(JSON.parse(text));
      if (res.status !== HTTP_FORBIDDEN) failures.push(`${c.label}: status ${res.status}`);
      if (text.includes(ENGLISH_ROLE_DETAIL)) failures.push(`${c.label}: 例外の文面が本文にある`);
      if (isEnglishOnly(message) || message === 'undefined') failures.push(`${c.label}: 文が日本語でない「${message}」`);
      if (code === 'FORBIDDEN' && message !== API_FORBIDDEN_MESSAGE) failures.push(`${c.label}: 「${message}」`);
    }
    expect(failures).toEqual([]);
    expect(dbTouched).not.toHaveBeenCalled();
  });

  it('code は従来のまま (UNAUTHORIZED / FORBIDDEN の route と、AUTH_UNAUTHENTICATED / OP_PERMISSION_DENIED の route だけ)', async () => {
    const codes = new Set<string>();
    for (const c of cases) {
      requireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED', ENGLISH_UNAUTHENTICATED_DETAIL));
      codes.add(`401 ${messageOf(await (await c.handler(requestOf(c), { params: Promise.resolve({ id: ROUTE_ID, key: ROUTE_KEY }) })).json()).code}`);
      requireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED', ENGLISH_ROLE_DETAIL));
      codes.add(`403 ${messageOf(await (await c.handler(requestOf(c), { params: Promise.resolve({ id: ROUTE_ID, key: ROUTE_KEY }) })).json()).code}`);
    }
    expect([...codes].sort()).toEqual(['401 AUTH_UNAUTHENTICATED', '401 UNAUTHORIZED', '403 FORBIDDEN', '403 OP_PERMISSION_DENIED']);
  });
});

/** ログ (logger.error など) と例外を作る (new Error(...)) 引数の中は、本文に届かないので数えない */
const LOG_METHODS = new Set(['error', 'warn', 'info', 'debug', 'log']);

function isInsideLogOrNewError(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isNewExpression(current) && ts.isIdentifier(current.expression) && current.expression.text.endsWith('Error')) return true;
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      LOG_METHODS.has(current.expression.name.text)
    ) {
      return true;
    }
  }
  return false;
}

describe('直し終えた super-admin・operator の route のソースに、エラーの文面を本文に渡す形が無い (走査の見張りが見ない関数の引数の形)', () => {
  it('`.message` を読むのは、ログと new Error の引数の中だけ', () => {
    const found: string[] = [];
    for (const file of OWN_ROUTE_FILES) {
      const sf = sourceOf(file);
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === 'message' && !isInsideLogOrNewError(node)) {
          found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(found).toEqual([]);
  });
});

describe('super-admin の 400 の文 (src/lib/super-admin/validation-errors.ts)', () => {
  const schema = z.object({ monthly_price_jpy: z.number(), name: z.string().min(1, '名前を書いてください') });

  it('Zod の既定の英語の文は、日本語の固定の文に項目の名前を添えた文にする (message も details も)', () => {
    const parsed = schema.safeParse({ monthly_price_jpy: 'x', name: 'a' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(isEnglishOnly(parsed.error.issues[0].message)).toBe(true);
    const body = invalidInputBody(parsed.error.issues);
    expect(body.error.code).toBe('OP_INVALID_INPUT');
    expect(body.error.message).toBe(`${SUPER_ADMIN_INVALID_INPUT_FALLBACK_MESSAGE} (monthly_price_jpy)`);
    expect(body.error.details.map((d) => d.message)).toEqual([`${SUPER_ADMIN_INVALID_INPUT_FALLBACK_MESSAGE} (monthly_price_jpy)`]);
    expect(body.error.details[0].path).toEqual(['monthly_price_jpy']);
    expect(JSON.stringify(body)).not.toContain(parsed.error.issues[0].message);
  });

  it('schema に書いた日本語の文はそのまま (message も details も)', () => {
    const parsed = schema.safeParse({ monthly_price_jpy: 1, name: '' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const body = invalidQueryBody(parsed.error.issues);
    expect(body.error).toEqual({ code: 'OP_INVALID_QUERY', message: '名前を書いてください', details: parsed.error.issues });
  });

  it('項目の名前が無い英語の文は、code ごとの固定の文だけ。issue が無いときも固定の文', () => {
    const rootIssue = { code: 'custom', path: [], message: 'Invalid input', input: 0 } as never;
    expect(validationMessageOf('OP_INVALID_INPUT', rootIssue)).toBe(SUPER_ADMIN_INVALID_INPUT_FALLBACK_MESSAGE);
    expect(validationMessageOf('OP_INVALID_QUERY', rootIssue)).toBe(SUPER_ADMIN_INVALID_QUERY_FALLBACK_MESSAGE);
    expect(validationMessageOf('OP_INVALID_QUERY', undefined)).toBe(SUPER_ADMIN_INVALID_QUERY_FALLBACK_MESSAGE);
    const nested = { code: 'custom', path: ['variants', 0, 'weight'], message: 'Too small', input: 0 } as never;
    expect(validationMessageOf('OP_INVALID_QUERY', nested)).toBe(`${SUPER_ADMIN_INVALID_QUERY_FALLBACK_MESSAGE} (variants.0.weight)`);
  });
});

describe('クーポンの適用の業務エラーの文 (src/lib/plan/coupon.ts の couponApplyErrorMessageOf)', () => {
  it('業務エラーの表の日本語の固定の文はそのまま', () => {
    for (const message of ['クーポンが見つかりません', 'この組織はクーポンの利用上限に達しています', '契約 (組織) が見つかりません']) {
      expect(couponApplyErrorMessageOf(new CouponApplyError('OP_X', message))).toBe(message);
    }
  });

  it('表の外の文面 (英語の文・DB の生の文) は、日本語の固定の文にする', () => {
    expect(couponApplyErrorMessageOf(new CouponApplyError('OP_COUPON_INVALID', 'Coupon is not active'))).toBe(
      COUPON_APPLY_FAILED_MESSAGE,
    );
    expect(couponApplyErrorMessageOf(new CouponApplyError('OP_COUPON_INVALID', '想定外の日本語の文'))).toBe(
      COUPON_APPLY_FAILED_MESSAGE,
    );
  });
});
