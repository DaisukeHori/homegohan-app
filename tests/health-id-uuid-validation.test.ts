/**
 * 健康の [id] の route は、id が UUID の形式でなければ DB に投げずに 400 を返す (#1478。#1398 の残り)
 *
 * 修正前: health_goals / health_checkups / health_insights の id は uuid 型の列で、UUID でない文字列を
 * .eq('id', value) に渡すと PostgREST が 22P02 で失敗し、「存在しない id」なのに 500 になっていた。
 * 修正後: 認証を確かめたあと、DB に投げる前に isUuid (src/lib/http-params.ts) で弾き、
 * 400 { error: INVALID_ID_PARAM_MESSAGE, code: 'VALIDATION_ERROR' } を返す。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INVALID_ID_PARAM_CODE, INVALID_ID_PARAM_MESSAGE } from '@/lib/http-params';

const h = vi.hoisted(() => ({
  user: { id: '55555555-5555-4555-8555-555555555555' } as { id: string } | null,
  fromCalls: [] as string[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
    from: (table: string) => {
      h.fromCalls.push(table);
      throw new Error(`DB に投げてはいけない (${table})`);
    },
    storage: {
      from: () => {
        throw new Error('storage に触れてはいけない');
      },
    },
  }),
}));

vi.mock('@/lib/db-logger', () => {
  const make = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  return { createLogger: () => ({ ...make(), withUser: () => make() }), generateRequestId: () => 'req_test' };
});

import * as goalById from '@/app/api/health/goals/[id]/route';
import * as checkupById from '@/app/api/health/checkups/[id]/route';
import * as insightRead from '@/app/api/health/insights/[id]/read/route';

function req(method: string, path: string, body?: unknown): NextRequest {
  const url = `http://localhost${path}`;
  return body === undefined
    ? new NextRequest(url, { method })
    : new NextRequest(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

type Run = (id: string) => Promise<Response>;
const ROUTES: Array<[string, Run]> = [
  ['GET /api/health/goals/[id]', (id) => goalById.GET(req('GET', `/api/health/goals/${encodeURIComponent(id)}`), params(id))],
  ['PUT /api/health/goals/[id]', (id) => goalById.PUT(req('PUT', `/api/health/goals/${encodeURIComponent(id)}`, { current_value: 65 }), params(id))],
  ['DELETE /api/health/goals/[id]', (id) => goalById.DELETE(req('DELETE', `/api/health/goals/${encodeURIComponent(id)}`), params(id))],
  ['GET /api/health/checkups/[id]', (id) => checkupById.GET(req('GET', `/api/health/checkups/${encodeURIComponent(id)}`), params(id))],
  ['PUT /api/health/checkups/[id]', (id) => checkupById.PUT(req('PUT', `/api/health/checkups/${encodeURIComponent(id)}`, { weight: 60 }), params(id))],
  ['DELETE /api/health/checkups/[id]', (id) => checkupById.DELETE(req('DELETE', `/api/health/checkups/${encodeURIComponent(id)}`), params(id))],
  ['POST /api/health/insights/[id]/read', (id) => insightRead.POST(req('POST', `/api/health/insights/${encodeURIComponent(id)}/read`), params(id))],
];

/** UUID の形式でない id の例 (数字だけ・ハイフンの位置違い・長さ違い・SQL のような文字列・空白) */
const NON_UUID_IDS = ['row-1', '123', 'not-a-uuid', '00000000-0000-0000-0000-00000000000', "1' OR '1'='1", ' '];

beforeEach(() => {
  h.user = { id: '55555555-5555-4555-8555-555555555555' };
  h.fromCalls = [];
});

describe.each(ROUTES)('%s', (_name, run) => {
  it.each(NON_UUID_IDS)('id が %j なら DB に投げずに 400 VALIDATION_ERROR (500 にしない)', async (id) => {
    const res = await run(id);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: INVALID_ID_PARAM_MESSAGE, code: INVALID_ID_PARAM_CODE });
    expect(h.fromCalls).toEqual([]);
  });

  it('ログインしていなければ、id の形式より先に 401', async () => {
    h.user = null;
    const res = await run('not-a-uuid');
    expect(res.status).toBe(401);
    expect(h.fromCalls).toEqual([]);
  });

  it('UUID の形式の id は弾かず、DB に投げる (検査の空振りでないことの確かめ)', async () => {
    // この作り物の DB は投げられたら例外にするので、route は 500 か例外になる。ここでは DB に届いたことだけを見る
    await run('66666666-6666-4666-8666-666666666666').catch(() => undefined);
    expect(h.fromCalls.length).toBeGreaterThan(0);
  });
});
