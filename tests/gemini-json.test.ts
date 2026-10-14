import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchImageAsBase64, generateGeminiJson } from '../src/lib/ai/gemini-json';

function mockGeminiResponse(text: string) {
  return {
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ text }],
          },
        },
      ],
    }),
  } as Response;
}

describe('generateGeminiJson', () => {
  const originalApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;

  beforeEach(() => {
    process.env.GOOGLE_AI_STUDIO_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.GOOGLE_AI_STUDIO_API_KEY = originalApiKey;
  });

  it('parses JSON wrapped in markdown fences', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockGeminiResponse('```json\n{"type":"meal","confidence":0.9}\n```'),
    ));

    const result = await generateGeminiJson<{ type: string; confidence: number }>({
      prompt: 'test',
      schema: { type: 'object' },
    });

    expect(result.data).toEqual({ type: 'meal', confidence: 0.9 });
  });

  it('retries once when the first response is malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(mockGeminiResponse('not-json-at-all'))
      .mockResolvedValueOnce(mockGeminiResponse('{"type":"meal","confidence":0.9,"description":"修正済み"}')));

    const result = await generateGeminiJson<{ type: string; confidence: number; description: string }>({
      prompt: 'test',
      schema: { type: 'object' },
    });

    expect(result.data).toEqual({
      type: 'meal',
      confidence: 0.9,
      description: '修正済み',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

/**
 * #1444 (CodeQL js/request-forgery) の回帰テスト。
 * 画像を取りに行く URL は、受け取った文字列ではなく、許可リストのホストと解析済みのパス・クエリから組み立て直す。
 * リダイレクトは追わない (許可したホストからリダイレクトで別のホストへ出られない)。
 */
describe('fetchImageAsBase64 (SSRF の守り)', () => {
  /** テスト用の Supabase のホスト (許可リストに入る) */
  const PROJECT_HOST = 'testproject.supabase.co';
  /** 静的フォールバックとして常に許可されるホスト (src/lib/ai/gemini-json.ts の getAllowedImageHosts) */
  const FALLBACK_HOST = 'flmeolcfutuwwbjmzyoz.supabase.co';

  function imageResponse(): Response {
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
  }

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', `https://${PROJECT_HOST}`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('許可したホストの画像は、組み立て直した URL でリダイレクトを追わずに取る', async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchImageAsBase64(`https://${PROJECT_HOST}/storage/v1/object/sign/fridge/a.png?token=abc`);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${PROJECT_HOST}/storage/v1/object/sign/fridge/a.png?token=abc`);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ base64: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' });
  });

  it('利用者の情報・ポートの指定・フラグメントは落として、許可リストのホストへだけ行く', async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal('fetch', fetchMock);

    await fetchImageAsBase64(`https://user:secret@${FALLBACK_HOST}:8443/storage/v1/object/public/a.png#frag`);

    expect(fetchMock.mock.calls[0][0]).toBe(`https://${FALLBACK_HOST}/storage/v1/object/public/a.png`);
  });

  it('パスが // で始まっても、ホストは許可リストのまま (プロトコル相対の URL に化けない)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal('fetch', fetchMock);

    await fetchImageAsBase64(`https://${PROJECT_HOST}//evil.example/a.png`);

    const fetched = new URL(fetchMock.mock.calls[0][0] as string);
    expect(fetched.hostname).toBe(PROJECT_HOST);
    expect(fetched.pathname).toBe('//evil.example/a.png');
  });

  it.each([
    ['許可リストに無いホスト', 'https://evil.example/a.png', 'Image host not allowed'],
    ['許可したホスト名を前に含むだけの別のホスト', `https://${PROJECT_HOST}.evil.example/a.png`, 'Image host not allowed'],
    ['https 以外', `http://${PROJECT_HOST}/a.png`, 'Image URL must use HTTPS'],
    ['内部のアドレス', 'https://127.0.0.1/a.png', 'Image URL points to a private/internal host'],
    ['URL として読めない', 'not a url', 'Invalid image URL'],
  ])('%s は取りに行かずに失敗する', async (_label, imageUrl, message) => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchImageAsBase64(imageUrl)).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
