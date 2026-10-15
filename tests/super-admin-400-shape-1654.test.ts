// @vitest-environment node
//
// #1654: super-admin の 400 の本文の形と、壊れた JSON の本文の扱いの回帰テスト。
//
// 1. feature-packages と plans の 400 (OP_INVALID_INPUT / OP_INVALID_QUERY) は、以前は ZodError の message
//    (issues を JSON にした文字列。'[' で始まる) を `error.message` に入れ、クエリの 400 は `details` も無かった。
//    いまはクーポンの route (#1534 / #1641) と同じ形 = message は最初の issue の文・details は issues の全件。
// 2. 本文が JSON として読めないとき、以前は `await request.json()` の例外が外側の catch に落ちて 500 OP_INTERNAL_ERROR だった。
//    いまは 400 (OP_INVALID_INPUT の route は OP_INVALID_INPUT・VALIDATION_ERROR の route は VALIDATION_ERROR) で、DB に書かない。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUPER_ADMIN_INVALID_INPUT_FALLBACK_MESSAGE,
  SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE,
  SUPER_ADMIN_INVALID_QUERY_FALLBACK_MESSAGE,
  invalidInputBody,
  invalidJsonBodyBody,
  invalidQueryBody,
  readJsonBody,
} from '@/lib/super-admin/validation-errors';
import {
  COUPON_INVALID_INPUT_FALLBACK_MESSAGE,
  COUPON_INVALID_QUERY_FALLBACK_MESSAGE,
  couponInvalidInputBody,
  couponInvalidQueryBody,
} from '@/lib/super-admin/coupon-errors';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

/** DB に書く操作 (呼ばれたら記録する) */
const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete', 'rpc']);

/** 書き込みの記録 (テーブル名.操作) */
const writes: string[] = [];

/** `.single()` / `.maybeSingle()` が返す行 (plans/[id] PATCH の既存プランの取得など) */
let singleRow: Record<string, unknown> | null = null;

/** どのメソッドを呼んでも自分を返し、await すると空の結果になる Supabase のクライアントの代わり */
function fakeChain(table: string): unknown {
  const listResult = { data: [], error: null, count: 0 };
  const chain: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => resolve(listResult);
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => Promise.resolve({ data: singleRow, error: null });
        }
        return (..._args: unknown[]) => {
          if (typeof prop === 'string' && WRITE_METHODS.has(prop)) writes.push(`${table}.${prop}`);
          return chain;
        };
      },
    },
  );
  return chain;
}

const fakeClient = {
  from: (table: string) => fakeChain(table),
  rpc: (name: string) => {
    writes.push(`rpc.${name}`);
    return Promise.resolve({ data: null, error: null });
  },
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeClient),
  getSupabaseAdmin: () => fakeClient,
}));

const featurePackages = await import('@/app/api/super-admin/feature-packages/route');
const featurePackage = await import('@/app/api/super-admin/feature-packages/[id]/route');
const plans = await import('@/app/api/super-admin/plans/route');
const plan = await import('@/app/api/super-admin/plans/[id]/route');
const priceChange = await import('@/app/api/super-admin/plans/[id]/price-change/route');
const coupons = await import('@/app/api/super-admin/coupons/route');
const coupon = await import('@/app/api/super-admin/coupons/[id]/route');
const couponApply = await import('@/app/api/super-admin/coupons/[id]/apply/route');
const experiments = await import('@/app/api/super-admin/experiments/route');
const experiment = await import('@/app/api/super-admin/experiments/[id]/route');
const flags = await import('@/app/api/super-admin/flags/route');
const flag = await import('@/app/api/super-admin/flags/[key]/route');

const actor = { id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };
const ID = '123e4567-e89b-12d3-a456-426614174000';
const BASE = 'http://localhost/api/super-admin';
const HTTP_BAD_REQUEST = 400;

/** 壊れた JSON の本文の例 (どれも request.json() が SyntaxError を投げる) */
const BROKEN_BODIES = ['{"display_name": ', 'not json', '{a:1}'] as const;

type ErrorBody = { error: { code: string; message: string; details?: { path: (string | number)[]; message: string }[] } };

function jsonRequest(url: string, method: string, body: string): never {
  return new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body }) as never;
}

function getRequest(url: string): never {
  const req = new Request(url, { method: 'GET' });
  // route は request.nextUrl.searchParams を読む (NextRequest の nextUrl の代わり)
  return Object.assign(req, { nextUrl: new URL(url) }) as never;
}

const idContext = { params: Promise.resolve({ id: ID }) } as never;
const keyContext = { params: Promise.resolve({ key: 'some_flag' }) } as never;

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  singleRow = null;
  mockRequireRole.mockResolvedValue(actor);
});

/** 400 の本文が新しい形か (message は最初の issue の文で '[' で始まらない・details に issues) */
async function expectFirstIssueShape(res: Response, code: string): Promise<ErrorBody['error']> {
  expect(res.status).toBe(HTTP_BAD_REQUEST);
  const json = (await res.json()) as ErrorBody;
  expect(json.error.code).toBe(code);
  expect(Array.isArray(json.error.details)).toBe(true);
  expect(json.error.details!.length).toBeGreaterThan(0);
  expect(json.error.message).toBe(json.error.details![0].message);
  expect(json.error.message.trimStart().startsWith('[')).toBe(false);
  expect(json.error.message.trimStart().startsWith('{')).toBe(false);
  return json.error;
}

describe('validation-errors (#1654 super-admin 全体の 400 の本文)', () => {
  it('message は最初の issue の文・details は issues の全件', () => {
    const issues = [
      { code: 'custom', path: ['a'], message: '一つ目', input: 1 },
      { code: 'custom', path: ['b'], message: '二つ目', input: 2 },
    ] as const;
    expect(invalidInputBody(issues as never)).toEqual({
      error: { code: 'OP_INVALID_INPUT', message: '一つ目', details: issues },
    });
    expect(invalidQueryBody(issues as never)).toEqual({
      error: { code: 'OP_INVALID_QUERY', message: '一つ目', details: issues },
    });
  });

  it('issues が空のときはコードごとの固定の文', () => {
    expect(invalidInputBody([]).error.message).toBe(SUPER_ADMIN_INVALID_INPUT_FALLBACK_MESSAGE);
    expect(invalidQueryBody([]).error.message).toBe(SUPER_ADMIN_INVALID_QUERY_FALLBACK_MESSAGE);
  });

  it('壊れた JSON の本文は OP_INVALID_INPUT・固定の文・details は空', () => {
    expect(invalidJsonBodyBody()).toEqual({
      error: { code: 'OP_INVALID_INPUT', message: SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE, details: [] },
    });
  });

  it('クーポン向けの名前 (coupon-errors) は同じ本文を返す (クーポンの route の挙動は変わらない)', () => {
    const issues = [{ code: 'custom', path: ['x'], message: '誤り', input: 0 }] as never;
    expect(couponInvalidInputBody(issues)).toEqual(invalidInputBody(issues));
    expect(couponInvalidQueryBody(issues)).toEqual(invalidQueryBody(issues));
    expect(COUPON_INVALID_INPUT_FALLBACK_MESSAGE).toBe(SUPER_ADMIN_INVALID_INPUT_FALLBACK_MESSAGE);
    expect(COUPON_INVALID_QUERY_FALLBACK_MESSAGE).toBe(SUPER_ADMIN_INVALID_QUERY_FALLBACK_MESSAGE);
  });

  it('readJsonBody: 読めれば ok・壊れていれば ok でない (例外にしない)', async () => {
    await expect(readJsonBody(new Request(BASE, { method: 'POST', body: '{"a":1}' }))).resolves.toEqual({
      ok: true,
      body: { a: 1 },
    });
    for (const broken of BROKEN_BODIES) {
      await expect(readJsonBody(new Request(BASE, { method: 'POST', body: broken }))).resolves.toEqual({ ok: false });
    }
    await expect(readJsonBody(new Request(BASE, { method: 'POST' }))).resolves.toEqual({ ok: false });
  });
});

describe('feature-packages と plans の 400 の本文 (#1654 クーポンと同じ形)', () => {
  it('GET /feature-packages: 範囲外の status は 400 OP_INVALID_QUERY (details あり)', async () => {
    const res = await featurePackages.GET(getRequest(`${BASE}/feature-packages?status=bogus`));
    const err = await expectFirstIssueShape(res, 'OP_INVALID_QUERY');
    expect(err.details![0].path).toEqual(['status']);
  });

  it('GET /plans: 範囲外の type は 400 OP_INVALID_QUERY (details あり)', async () => {
    const res = await plans.GET(getRequest(`${BASE}/plans?type=bogus`));
    const err = await expectFirstIssueShape(res, 'OP_INVALID_QUERY');
    expect(err.details![0].path).toEqual(['type']);
  });

  it('POST /feature-packages: 必須の項目が無ければ 400 OP_INVALID_INPUT で、DB に書かない', async () => {
    const res = await featurePackages.POST(jsonRequest(`${BASE}/feature-packages`, 'POST', '{}'));
    await expectFirstIssueShape(res, 'OP_INVALID_INPUT');
    expect(writes).toEqual([]);
  });

  it('PATCH /feature-packages/[id]: 型の違う値は 400 OP_INVALID_INPUT で、DB に書かない', async () => {
    const res = await featurePackage.PATCH(
      jsonRequest(`${BASE}/feature-packages/${ID}`, 'PATCH', JSON.stringify({ display_order: 'first' })),
      idContext,
    );
    const err = await expectFirstIssueShape(res, 'OP_INVALID_INPUT');
    expect(err.details![0].path).toEqual(['display_order']);
    expect(writes).toEqual([]);
  });

  it('POST /plans: 必須の項目が無ければ 400 OP_INVALID_INPUT で、DB に書かない', async () => {
    const res = await plans.POST(jsonRequest(`${BASE}/plans`, 'POST', '{}'));
    await expectFirstIssueShape(res, 'OP_INVALID_INPUT');
    expect(writes).toEqual([]);
  });

  it('PATCH /plans/[id]: 型の違う値は 400 OP_INVALID_INPUT で、DB に書かない', async () => {
    singleRow = { id: ID, plan_key: 'p', status: 'draft', ends_at: null };
    const res = await plan.PATCH(
      jsonRequest(`${BASE}/plans/${ID}`, 'PATCH', JSON.stringify({ display_order: 'first' })),
      idContext,
    );
    const err = await expectFirstIssueShape(res, 'OP_INVALID_INPUT');
    expect(err.details![0].path).toEqual(['display_order']);
    expect(writes).toEqual([]);
  });
});

/** 本文を読む route (OP_INVALID_INPUT を返すもの) */
const OP_INVALID_INPUT_ROUTES: readonly [string, (body: string) => Promise<Response>][] = [
  ['POST /feature-packages', (b) => featurePackages.POST(jsonRequest(`${BASE}/feature-packages`, 'POST', b))],
  ['PATCH /feature-packages/[id]', (b) => featurePackage.PATCH(jsonRequest(`${BASE}/feature-packages/${ID}`, 'PATCH', b), idContext)],
  ['POST /plans', (b) => plans.POST(jsonRequest(`${BASE}/plans`, 'POST', b))],
  ['PATCH /plans/[id]', (b) => plan.PATCH(jsonRequest(`${BASE}/plans/${ID}`, 'PATCH', b), idContext)],
  ['POST /plans/[id]/price-change', (b) => priceChange.POST(jsonRequest(`${BASE}/plans/${ID}/price-change`, 'POST', b), idContext)],
  ['POST /coupons', (b) => coupons.POST(jsonRequest(`${BASE}/coupons`, 'POST', b))],
  ['PATCH /coupons/[id]', (b) => coupon.PATCH(jsonRequest(`${BASE}/coupons/${ID}`, 'PATCH', b), idContext)],
  ['POST /coupons/[id]/apply', (b) => couponApply.POST(jsonRequest(`${BASE}/coupons/${ID}/apply`, 'POST', b), idContext)],
];

/** 本文を読む route (この route の他の 400 と同じく VALIDATION_ERROR を返すもの) */
const VALIDATION_ERROR_ROUTES: readonly [string, (body: string) => Promise<Response>][] = [
  ['POST /experiments', (b) => experiments.POST(jsonRequest(`${BASE}/experiments`, 'POST', b))],
  ['PATCH /experiments/[id]', (b) => experiment.PATCH(jsonRequest(`${BASE}/experiments/${ID}`, 'PATCH', b), idContext)],
  ['POST /flags', (b) => flags.POST(jsonRequest(`${BASE}/flags`, 'POST', b))],
  ['PATCH /flags/[key]', (b) => flag.PATCH(jsonRequest(`${BASE}/flags/some_flag`, 'PATCH', b), keyContext)],
];

describe('壊れた JSON の本文は 400 (#1654 以前は外側の catch で 500)', () => {
  beforeEach(() => {
    // plans/[id] PATCH は本文を読む前に既存のプランを取る
    singleRow = { id: ID, plan_key: 'p', status: 'draft', ends_at: null };
  });

  for (const [label, call] of OP_INVALID_INPUT_ROUTES) {
    it.each(BROKEN_BODIES)(`${label}: 400 OP_INVALID_INPUT・固定の文・details は空・DB に書かない (本文 %s)`, async (broken) => {
      const res = await call(broken);
      expect(res.status).toBe(HTTP_BAD_REQUEST);
      expect(await res.json()).toEqual({
        error: { code: 'OP_INVALID_INPUT', message: SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE, details: [] },
      });
      expect(writes).toEqual([]);
    });
  }

  for (const [label, call] of VALIDATION_ERROR_ROUTES) {
    it.each(BROKEN_BODIES)(`${label}: 400 VALIDATION_ERROR・固定の文・DB に書かない (本文 %s)`, async (broken) => {
      const res = await call(broken);
      expect(res.status).toBe(HTTP_BAD_REQUEST);
      expect(await res.json()).toEqual({
        error: { code: 'VALIDATION_ERROR', message: SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE },
      });
      expect(writes).toEqual([]);
    });
  }

  it('apply: 本文が JSON として読めれば従来どおり Zod で検証する (400 は最初の issue の文)', async () => {
    const res = await couponApply.POST(
      jsonRequest(`${BASE}/coupons/${ID}/apply`, 'POST', JSON.stringify({ subscription_target: 'team', subscription_id: ID })),
      idContext,
    );
    const err = await expectFirstIssueShape(res, 'OP_INVALID_INPUT');
    expect(err.message).not.toBe(SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE);
  });
});
