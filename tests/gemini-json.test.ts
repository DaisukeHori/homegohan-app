import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateGeminiJson } from '../src/lib/ai/gemini-json';

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
