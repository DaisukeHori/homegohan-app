// @vitest-environment node
/**
 * src/lib/api/errors.ts (#1172) internalError() の単体テスト
 *
 * 確かめること:
 *   1. 本文は汎用メッセージだけ。元のエラー (文面・スタック・コード・details・hint) は 1 文字も出ない
 *   2. 本文の形: 既定 (flat) は `error` が文字列 (画面が data.error をそのまま表示してよい)、nested は `error.message`
 *   3. 元のエラーは構造化ログに残る (Error でも supabase-js の素のオブジェクトでも文字列でも、原因の文面が消えない)
 *   4. userId / requestId / それ以外の文脈の渡し方
 *   5. ログの記録に失敗しても、利用者には汎用の 500 を返す
 *
 * 構造化ログはモックなので app_logs へは書かない。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  errorCalls: [] as Array<{ userId?: string; message: string; error: unknown; metadata?: Record<string, unknown> }>,
  createLoggerCalls: [] as Array<{ routeName: string; requestId?: string }>,
  /** 設定すると createLogger() がこの例外を投げる */
  createLoggerThrows: null as Error | null,
  /** 設定すると logger.error() がこの例外を投げる */
  loggerErrorThrows: null as Error | null,
  nextRequestId: 'req_generated',
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: (routeName: string, requestId?: string) => {
    if (h.createLoggerThrows) throw h.createLoggerThrows;
    h.createLoggerCalls.push({ routeName, requestId });
    const make = (userId?: string) => ({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message: string, error?: unknown, metadata?: Record<string, unknown>) => {
        if (h.loggerErrorThrows) throw h.loggerErrorThrows;
        h.errorCalls.push({ userId, message, error, metadata });
      },
    });
    return { ...make(), withUser: (userId: string) => make(userId) };
  },
  generateRequestId: () => h.nextRequestId,
}));

import {
  INTERNAL_ERROR_CODE,
  INTERNAL_ERROR_MESSAGE,
  internalError,
  type InternalErrorFlatBody,
} from '@/lib/api/errors';

const ROUTE = 'GET /api/health/goals';

/** PostgREST が返す形 (supabase-js の古い版・モックでは Error ではなく素のオブジェクトで来る) */
const postgrestError = {
  message: 'duplicate key value violates unique constraint "health_goals_pkey"',
  code: '23505',
  details: 'Key (id)=(goal-1) already exists.',
  hint: 'use upsert instead',
};

beforeEach(() => {
  h.errorCalls.length = 0;
  h.createLoggerCalls.length = 0;
  h.createLoggerThrows = null;
  h.loggerErrorThrows = null;
  h.nextRequestId = 'req_generated';
  vi.restoreAllMocks();
});

describe('定数', () => {
  it('汎用メッセージと code は決められた文字列', () => {
    expect(INTERNAL_ERROR_MESSAGE).toBe('処理中にエラーが発生しました');
    expect(INTERNAL_ERROR_CODE).toBe('INTERNAL_ERROR');
  });
});

describe('応答', () => {
  it('既定 (flat): 500 と { error: <文字列>, code } を JSON で返す', async () => {
    const res = internalError(ROUTE, new Error('boom'));

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
  });

  it('flat は error が文字列のまま: 画面が data.error をそのまま表示しても、オブジェクトを描画して落ちない', async () => {
    const body = (await internalError(ROUTE, new Error('boom')).json()) as InternalErrorFlatBody;

    // 例: setError(data?.error || '失敗しました') して <p>{error}</p> と描画する画面 (health/goals, profile など)
    expect(typeof body.error).toBe('string');
    expect(body.error).toBe(INTERNAL_ERROR_MESSAGE);
    // new Error(data.error) が "[object Object]" にならない
    expect(new Error(body.error).message).toBe(INTERNAL_ERROR_MESSAGE);
  });

  it("shape: 'nested' は { error: { code, message } } (運営 API の形)", async () => {
    const res = internalError(ROUTE, new Error('boom'), {}, { shape: 'nested' });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' },
    });
  });

  it("shape: 'flat' を明示しても既定と同じ", async () => {
    expect(await internalError(ROUTE, new Error('boom'), {}, { shape: 'flat' }).json()).toEqual({
      error: '処理中にエラーが発生しました',
      code: 'INTERNAL_ERROR',
    });
  });
});

describe('元のエラーを本文に出さない', () => {
  const circular: Record<string, unknown> = { message: 'circular boom: secret_table_xyz' };
  circular.self = circular;

  const withStack = new Error('connect ECONNREFUSED 10.9.8.7:5432 (secret_host_xyz)');
  (withStack as Error & { code?: string }).code = 'ECONNREFUSED';

  it.each([
    // スタックには、この Error を作ったファイルの名前 (api-errors.test) が入る
    ['Error (スタック付き・code 付き)', withStack, ['ECONNREFUSED', '10.9.8.7', 'secret_host_xyz', 'api-errors.test']],
    [
      'supabase-js の素のオブジェクト (message / code / details / hint)',
      postgrestError,
      ['health_goals_pkey', '23505', 'already exists', 'use upsert instead'],
    ],
    ['文字列', 'raw failure: secret_table_xyz', ['secret_table_xyz']],
    ['循環参照を含むオブジェクト', circular, ['circular boom', 'secret_table_xyz']],
    ['null', null, []],
    ['undefined', undefined, []],
    ['数値', 42, []],
  ])('%s', async (_label, error, leakedFragments) => {
    for (const nested of [false, true]) {
      const res = internalError(ROUTE, error, {}, nested ? { shape: 'nested' } : {});
      const text = await res.text();

      expect(res.status).toBe(500);
      for (const fragment of leakedFragments) {
        expect(text, `本文に ${fragment} が出ている: ${text}`).not.toContain(fragment);
      }
      // 本文のキーは決まったものだけ (details / stack / hint などを足していない)
      const keys = Object.keys(JSON.parse(text));
      expect(keys.sort()).toEqual(nested ? ['error'] : ['code', 'error']);
    }
  });

  it('ctx に入れたメタデータ (table など) も本文には出ない', async () => {
    const text = await internalError(ROUTE, new Error('boom'), {
      userId: 'user-secret-1',
      requestId: 'req_secret_1',
      table: 'secret_table_xyz',
    }).text();

    expect(text).not.toContain('user-secret-1');
    expect(text).not.toContain('req_secret_1');
    expect(text).not.toContain('secret_table_xyz');
  });
});

describe('構造化ログへの記録', () => {
  it('Error はそのまま (同じインスタンスを) 渡す。スタックが残る', () => {
    const error = new Error('boom');

    internalError(ROUTE, error);

    expect(h.errorCalls).toHaveLength(1);
    expect(h.errorCalls[0].error).toBe(error);
    expect(h.errorCalls[0].message).toBe('内部エラーのため 500 を返しました');
    expect(h.createLoggerCalls[0].routeName).toBe(ROUTE);
  });

  it('supabase-js の素のオブジェクトは Error に包み、message と error_code を残す (String() で "[object Object]" にしない)', () => {
    internalError(ROUTE, postgrestError);

    const [{ error, metadata }] = h.errorCalls;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(postgrestError.message);
    expect(metadata).toEqual({ error_code: '23505' });
  });

  it('文字列は Error に包む', () => {
    internalError(ROUTE, 'raw failure');

    expect((h.errorCalls[0].error as Error).message).toBe('raw failure');
    expect(h.errorCalls[0].metadata).toEqual({});
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['数値', 42],
    ['message の無いオブジェクト', { foo: 'bar' }],
    ['message が空の素のオブジェクト', { message: '' }],
    ['message が文字列でない素のオブジェクト', { message: 123 }],
  ])('原因が取れないもの (%s) は Unknown error として記録する', (_label, error) => {
    internalError(ROUTE, error);

    expect((h.errorCalls[0].error as Error).message).toBe('Unknown error');
  });

  it('Error の code (文字列) も error_code に残す。文字列でない code は残さない', () => {
    const withCode = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    internalError(ROUTE, withCode);
    internalError(ROUTE, Object.assign(new Error('x'), { code: 500 }));
    internalError(ROUTE, Object.assign(new Error('y'), { code: '' }));

    expect(h.errorCalls[0].metadata).toEqual({ error_code: 'ECONNRESET' });
    expect(h.errorCalls[1].metadata).toEqual({});
    expect(h.errorCalls[2].metadata).toEqual({});
  });

  it('userId を渡すと利用者 ID 付き (withUser) で記録し、メタデータには入れない', () => {
    internalError(ROUTE, new Error('boom'), { userId: 'user-1', table: 'health_goals' });

    expect(h.errorCalls).toHaveLength(1);
    expect(h.errorCalls[0].userId).toBe('user-1');
    expect(h.errorCalls[0].metadata).toEqual({ table: 'health_goals' });
  });

  it('userId が無いときは利用者 ID を付けない', () => {
    internalError(ROUTE, new Error('boom'), { table: 'health_goals' });

    expect(h.errorCalls[0].userId).toBeUndefined();
  });

  it('requestId を渡すとそれを使い、無ければ generateRequestId() で発行する。メタデータには入れない', () => {
    internalError(ROUTE, new Error('a'), { requestId: 'req_from_route' });
    internalError(ROUTE, new Error('b'));

    expect(h.createLoggerCalls.map((c) => c.requestId)).toEqual(['req_from_route', 'req_generated']);
    expect(h.errorCalls[0].metadata).toEqual({});
    expect(h.errorCalls[1].metadata).toEqual({});
  });

  it('ctx のそれ以外のキーはメタデータとして渡し、error_code と並べる', () => {
    internalError(ROUTE, postgrestError, { table: 'health_goals', query: 'select' });

    expect(h.errorCalls[0].metadata).toEqual({ error_code: '23505', table: 'health_goals', query: 'select' });
  });

  it('渡された ctx を書き換えない', () => {
    const ctx = { userId: 'user-1', requestId: 'req_1', table: 'health_goals' };

    internalError(ROUTE, new Error('boom'), ctx);

    expect(ctx).toEqual({ userId: 'user-1', requestId: 'req_1', table: 'health_goals' });
  });

  it('1 回の呼び出しで記録するのは 1 回だけ', () => {
    internalError(ROUTE, new Error('boom'), { userId: 'user-1' });

    expect(h.errorCalls).toHaveLength(1);
  });
});

describe('ログの記録に失敗したとき', () => {
  it('createLogger が例外を投げても、汎用の 500 を返す (元のエラーは標準エラー出力に残す)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.createLoggerThrows = new Error('logger init failed');
    const original = new Error('original failure');

    const res = internalError(ROUTE, original);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]).toContain(original);
  });

  it('logger.error が例外を投げても、汎用の 500 を返す', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.loggerErrorThrows = new Error('sanitize failed');

    const res = internalError(ROUTE, new Error('original failure'), { userId: 'user-1' }, { shape: 'nested' });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' },
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
