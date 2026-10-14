/**
 * GET /api/shopping-list/regenerate/status: 行の result.error に入った生のエラー文を返さない (#1172)
 *
 * shopping_list_requests.result.error には、Edge Function (regenerate-shopping-list-v2) が catch で捕まえた例外の文面が
 * そのまま入る (DB (PostgREST) の生のエラー文・外部の AI の応答の本文 'Fast LLM API error: 500 - ...')。
 * Web とアプリの画面は応答の result.error をそのまま出すので、route は
 *   - こちらで書いた文 (同意の 2 文・固定の文) だけをそのまま返し、
 *   - それ以外は固定の文 (SHOPPING_LIST_REQUEST_FAILED_MESSAGE) にし、
 *   - 成功の result (stats) と、ほかの項目 (requestId / status / progress) はそのまま返す
 * ことを確かめる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.fn();

type SingleResult = { data: Record<string, unknown> | null; error: { message: string; code?: string } | null };
const singleResultQueue: SingleResult[] = [];
const mockSingle = vi.fn(() => Promise.resolve(singleResultQueue.shift() ?? { data: null, error: { message: 'no rows' } }));
const mockEq2 = vi.fn((..._args: unknown[]) => ({ single: mockSingle }));
const mockEq1 = vi.fn((..._args: unknown[]) => ({ eq: mockEq2 }));
const mockSelect = vi.fn((..._args: unknown[]) => ({ eq: mockEq1 }));

const mockFrom = vi.fn((table: string) => {
  if (table === 'shopping_list_requests') return { select: mockSelect };
  throw new Error(`Unexpected table in test: ${table}`);
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser }, from: mockFrom })),
}));

const { GET } = await import('@/app/api/shopping-list/regenerate/status/route');
const { AI_CONSENT_REQUIRED_MESSAGE, AI_CONSENT_CHECK_FAILED_MESSAGE } = await import(
  '../../../../supabase/functions/_shared/ai-consent'
);
const { SHOPPING_LIST_REQUEST_FAILED_MESSAGE } = await import('@/lib/shopping-list-request-error');

const user = { id: 'user-1' };
const makeRequest = (requestId: string) =>
  new Request(`http://localhost/api/shopping-list/regenerate/status?requestId=${requestId}`);

/** Edge Function の markFailed が書く失敗の行 */
function failedRow(result: unknown) {
  return {
    id: 'req-1',
    status: 'failed',
    progress: { phase: 'failed', message: 'エラーが発生しました', percentage: 0 },
    result,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  singleResultQueue.length = 0;
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
});

describe('GET /api/shopping-list/regenerate/status: 失敗の文 (#1172)', () => {
  it.each([
    [
      'DB (PostgREST) の生のエラー文 (PostgrestError も Error なので message がそのまま入る)',
      'duplicate key value violates unique constraint "shopping_list_items_shopping_list_id_item_name_key"',
    ],
    [
      '外部の AI の応答の本文 (Fast LLM API error)',
      'Fast LLM API error: 500 - {"error":{"message":"The server had an error while processing your request","type":"server_error"}}',
    ],
    ['例外の文面', "TypeError: Cannot read properties of undefined (reading 'ingredients')"],
    ['Error でない値を投げたとき', 'Unknown error'],
  ])('%s は返さず、固定の文を返す', async (_label, stored) => {
    singleResultQueue.push({ data: failedRow({ error: stored }), error: null });

    const res = await GET(makeRequest('req-1'));
    const text = await res.text();
    const json = JSON.parse(text);

    expect(res.status).toBe(200);
    expect(json).toEqual({
      requestId: 'req-1',
      status: 'failed',
      progress: { phase: 'failed', message: 'エラーが発生しました', percentage: 0 },
      result: { error: SHOPPING_LIST_REQUEST_FAILED_MESSAGE },
    });
    expect(text).not.toContain(stored);
  });

  it('文字列でない error (オブジェクト) も中身を返さず、固定の文を返す', async () => {
    singleResultQueue.push({
      data: failedRow({ error: { message: 'relation "shopping_list_items" does not exist', code: '42P01' } }),
      error: null,
    });

    const res = await GET(makeRequest('req-1'));
    const text = await res.text();

    expect(JSON.parse(text).result).toEqual({ error: SHOPPING_LIST_REQUEST_FAILED_MESSAGE });
    expect(text).not.toContain('shopping_list_items');
    expect(text).not.toContain('42P01');
  });

  it.each([
    ['同意が無くて止めた文', AI_CONSENT_REQUIRED_MESSAGE],
    ['同意の状況を読めなくて止めた文', AI_CONSENT_CHECK_FAILED_MESSAGE],
    ['固定の文', SHOPPING_LIST_REQUEST_FAILED_MESSAGE],
  ])('こちらで書いた文 (%s) は、画面が見分けられるようそのまま返す', async (_label, stored) => {
    singleResultQueue.push({ data: failedRow({ error: stored }), error: null });

    const json = await (await GET(makeRequest('req-1'))).json();

    expect(json.status).toBe('failed');
    expect(json.result).toEqual({ error: stored });
  });

  it('成功の result (stats) はそのまま返す', async () => {
    const stats = { inputCount: 12, outputCount: 8, mergedCount: 4, totalServings: 21 };
    singleResultQueue.push({
      data: {
        id: 'req-1',
        status: 'completed',
        progress: { phase: 'completed', message: '完了！', percentage: 100 },
        result: { stats },
      },
      error: null,
    });

    const json = await (await GET(makeRequest('req-1'))).json();

    expect(json).toEqual({
      requestId: 'req-1',
      status: 'completed',
      progress: { phase: 'completed', message: '完了！', percentage: 100 },
      result: { stats },
    });
  });

  it('処理中で result がまだ無い (null) ときは null のまま返す', async () => {
    singleResultQueue.push({
      data: {
        id: 'req-1',
        status: 'processing',
        progress: { phase: 'starting', message: '開始中...', percentage: 0 },
        result: null,
      },
      error: null,
    });

    const json = await (await GET(makeRequest('req-1'))).json();

    expect(json.status).toBe('processing');
    expect(json.result).toBeNull();
    expect(json.progress).toEqual({ phase: 'starting', message: '開始中...', percentage: 0 });
  });

  it('オブジェクトでない result (文字列) は中身を返さず null にする', async () => {
    singleResultQueue.push({ data: failedRow('relation "shopping_list_requests" does not exist'), error: null });

    const res = await GET(makeRequest('req-1'));
    const text = await res.text();

    expect(JSON.parse(text).result).toBeNull();
    expect(text).not.toContain('does not exist');
  });

  it('本人の行だけを引く (user_id で絞る)', async () => {
    singleResultQueue.push({ data: failedRow({ error: AI_CONSENT_REQUIRED_MESSAGE }), error: null });

    await GET(makeRequest('req-1'));

    expect(mockSelect).toHaveBeenCalledWith('id, status, progress, result');
    expect(mockEq1).toHaveBeenCalledWith('id', 'req-1');
    expect(mockEq2).toHaveBeenCalledWith('user_id', user.id);
  });
});
