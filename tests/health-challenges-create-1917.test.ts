/**
 * #1917 POST /api/health/challenges の本文の検証の回帰テスト
 *
 * 以前は `const body = await request.json()` に catch が無く、壊れた JSON や JSON の null を送ると、捕まえていない例外で
 * Next の既定の 500 になった (internalError を通らないので構造化ログにも残らない)。custom_target は型も範囲も確かめずに
 * insert していた (文字列・負の値・numeric(10,2) を超える値が DB の失敗や不正な目標になった)。
 *
 * 直したあとの不変条件:
 *  - 本文が JSON のオブジェクトでない (壊れた JSON・null・配列) ときは 400 と固定の文 (HEALTH_INVALID_BODY_MESSAGE)。DB に書かない
 *  - custom_target は数値 (十進数の文字列も可) で、0 より大きく numeric(10,2) に収まる値だけ。それ以外は 400。DB に書かない
 *  - custom_target を送らない・null のときは、テンプレートの既定の目標値で作る
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HEALTH_GOAL_NUMERIC_MAX } from '@/lib/health-goal-types';
import { HEALTH_CHALLENGE_TEMPLATE_INVALID_MESSAGE, HEALTH_INVALID_BODY_MESSAGE } from '@/lib/health-api-messages';

const inserts: Array<Record<string, unknown>> = [];

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        inserts.push({ table, ...payload });
        return { select: () => ({ single: async () => ({ data: { id: 'challenge-1', ...payload }, error: null }) }) };
      },
    }),
  }),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: vi.fn(() => ({ ...logger, withUser: vi.fn(() => logger) })),
    generateRequestId: vi.fn(() => 'req_test'),
  };
});

const { POST } = await import('@/app/api/health/challenges/route');

/** 既定の目標値が 50000 歩のテンプレート (src/app/api/health/challenges/route.ts の steps_week) */
const STEPS_TEMPLATE = 'steps_week';
const STEPS_DEFAULT_TARGET = 50000;

function post(body: string) {
  return POST(
    new Request('http://localhost/api/health/challenges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }) as never,
  );
}

beforeEach(() => {
  inserts.length = 0;
});

describe('POST /api/health/challenges: 本文の検証 (#1917)', () => {
  it.each([
    ['壊れた JSON', '{"template_id": "steps_week"'],
    ['JSON の null', 'null'],
    ['配列', '["steps_week"]'],
  ])('%s は 400 と固定の文で、DB に書かない', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: HEALTH_INVALID_BODY_MESSAGE });
    expect(inserts).toEqual([]);
  });

  it.each([
    ['数値でない文字列', 'abc'],
    ['0', 0],
    ['負の値', -5],
    ['numeric(10,2) を超える値', HEALTH_GOAL_NUMERIC_MAX * 10],
    ['真偽値', true],
  ])('custom_target が %s なら 400 で、DB に書かない', async (_label, customTarget) => {
    const res = await post(JSON.stringify({ template_id: STEPS_TEMPLATE, custom_target: customTarget }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('custom_target');
    expect(inserts).toEqual([]);
  });

  it('知らないテンプレートは 400 (従来どおり)', async () => {
    const res = await post(JSON.stringify({ template_id: 'no_such_template' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: HEALTH_CHALLENGE_TEMPLATE_INVALID_MESSAGE });
    expect(inserts).toEqual([]);
  });

  it('custom_target を送らないときは、テンプレートの既定の目標値で作る', async () => {
    const res = await post(JSON.stringify({ template_id: STEPS_TEMPLATE }));
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ table: 'health_challenges', target_value: STEPS_DEFAULT_TARGET, user_id: 'user-1' });
  });

  it('custom_target が null のときも、テンプレートの既定の目標値で作る', async () => {
    const res = await post(JSON.stringify({ template_id: STEPS_TEMPLATE, custom_target: null }));
    expect(res.status).toBe(200);
    expect(inserts[0]).toMatchObject({ target_value: STEPS_DEFAULT_TARGET });
  });

  it.each([
    ['数値', 30000, 30000],
    ['十進数の文字列', '12.5', 12.5],
  ])('custom_target が %s なら、その値で作る', async (_label, customTarget, expected) => {
    const res = await post(JSON.stringify({ template_id: STEPS_TEMPLATE, custom_target: customTarget }));
    expect(res.status).toBe(200);
    expect(inserts[0]).toMatchObject({ target_value: expected });
  });
});
