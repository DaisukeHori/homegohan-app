import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.fn();
const mockInvoke = vi.fn();
const mockUpload = vi.fn();
const mockGetPublicUrl = vi.fn();
const mockGenerateContent = vi.fn();
const mockFrom = vi.fn();
const mockUpdate = vi.fn();
const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockSingle = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    functions: { invoke: mockInvoke },
    from: mockFrom,
    storage: {
      from: vi.fn(() => ({
        upload: mockUpload,
        getPublicUrl: mockGetPublicUrl,
      })),
    },
  })),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => undefined),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: mockGenerateContent,
    };
  },
  createUserContent: vi.fn((parts) => parts),
}));

describe('image route contracts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockInvoke.mockReset();
    mockUpload.mockResolvedValue({ error: null });
    mockGetPublicUrl.mockReturnValue({ data: { publicUrl: 'https://example.com/generated.png' } });
    mockGenerateContent.mockReset();
    mockSingle.mockResolvedValue({ data: { id: 'meal-1' }, error: null });
    mockSelect.mockReturnValue({ single: mockSingle });
    mockEq.mockReturnValue({ select: mockSelect });
    mockUpdate.mockReturnValue({ eq: mockEq });
    mockFrom.mockReturnValue({ update: mockUpdate });
    process.env.GOOGLE_AI_STUDIO_API_KEY = 'test-key';
    delete process.env.GEMINI_IMAGE_MODEL;
    delete process.env.GEMINI_VISION_MODEL;
  });

  it('analyze-weight-scale reads the nested health-photo response shape', async () => {
    mockInvoke.mockResolvedValue({
      data: {
        success: true,
        result: {
          type: 'weight_scale',
          values: {
            weight: 65.2,
            body_fat_percentage: 18.4,
            muscle_mass: 48.1,
          },
          confidence: 0.93,
          raw_text: '65.2',
        },
      },
      error: null,
    });

    const { POST } = await import('../src/app/api/ai/analyze-weight-scale/route');
    const response = await POST(new Request('http://localhost/api/ai/analyze-weight-scale', {
      method: 'POST',
      body: JSON.stringify({ image: 'base64-image' }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      weight: 65.2,
      bodyFat: 18.4,
      muscleMass: 48.1,
      confidence: 0.93,
      rawText: '65.2',
    });
  });

  it('analyze-meal-photo sync path delegates to the edge function', async () => {
    mockInvoke.mockResolvedValue({
      data: {
        dishes: [{ name: 'カレー', role: 'main', cal: 620 }],
        totalCalories: 620,
      },
      error: null,
    });

    const { POST } = await import('../src/app/api/ai/analyze-meal-photo/route');
    const response = await POST(new Request('http://localhost/api/ai/analyze-meal-photo', {
      method: 'POST',
      body: JSON.stringify({
        images: [{ base64: 'abc', mimeType: 'image/jpeg' }],
        mealType: 'dinner',
      }),
    }));

    expect(mockInvoke).toHaveBeenCalledWith('analyze-meal-photo', {
      body: {
        images: [{ base64: 'abc', mimeType: 'image/jpeg' }],
        mealId: undefined,
        mealType: 'dinner',
        userId: 'user-1',
      },
    });
    await expect(response.json()).resolves.toEqual({
      dishes: [{ name: 'カレー', role: 'main', cal: 620 }],
      totalCalories: 620,
    });
  });

  it('classify-photo accepts multiple images and returns normalized output', async () => {
    process.env.GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  type: 'fridge',
                  confidence: 0.88,
                  description: '冷蔵庫の棚',
                  candidates: [
                    { type: 'fridge', confidence: 0.88 },
                    { type: 'meal', confidence: 0.33 },
                  ],
                }),
              },
            ],
          },
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('../src/app/api/ai/classify-photo/route');
    const response = await POST(new Request('http://localhost/api/ai/classify-photo', {
      method: 'POST',
      body: JSON.stringify({
        images: [
          { base64: 'abc', mimeType: 'image/jpeg' },
          { base64: 'def', mimeType: 'image/png' },
        ],
      }),
    }));

    const payload = await response.json();
    expect(payload).toMatchObject({
      type: 'fridge',
      confidence: 0.88,
      description: '冷蔵庫の棚',
      modelUsed: 'gemini-3-flash-preview',
    });
    expect(payload.candidates).toEqual([
      { type: 'fridge', confidence: 0.88 },
      { type: 'meal', confidence: 0.33 },
    ]);

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.contents[0].parts).toHaveLength(3);
    expect(requestBody.generationConfig.responseMimeType).toBe('application/json');
  });

  it('classify-photo falls back to per-image classification when the batch result is weak', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    type: 'unknown',
                    confidence: 0.18,
                    description: '判別困難',
                    candidates: [
                      { type: 'meal', confidence: 0.34 },
                      { type: 'fridge', confidence: 0.29 },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    type: 'meal',
                    confidence: 0.81,
                    description: '食事写真',
                    candidates: [{ type: 'meal', confidence: 0.81 }],
                  }),
                },
              ],
            },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    type: 'meal',
                    confidence: 0.74,
                    description: '食事写真',
                    candidates: [{ type: 'meal', confidence: 0.74 }],
                  }),
                },
              ],
            },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('../src/app/api/ai/classify-photo/route');
    const response = await POST(new Request('http://localhost/api/ai/classify-photo', {
      method: 'POST',
      body: JSON.stringify({
        images: [
          { base64: 'abc', mimeType: 'image/jpeg' },
          { base64: 'def', mimeType: 'image/jpeg' },
        ],
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: 'meal',
      confidence: 0.78,
      description: '2枚を個別確認した結果',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('classify-photo recovers when Gemini returns malformed JSON', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"type":"meal","confidence":1.0',
                },
              ],
            },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"type":"meal","confidence":0.99,"description":"食事写真","candidates":[{"type":"meal","confidence":0.99}',
                },
              ],
            },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('../src/app/api/ai/classify-photo/route');
    const response = await POST(new Request('http://localhost/api/ai/classify-photo', {
      method: 'POST',
      body: JSON.stringify({
        images: [{ base64: 'abc', mimeType: 'image/jpeg' }],
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: 'meal',
      confidence: 0.99,
      recovered: true,
    });
  });

  it('image-generate uses Nano Banana 2 and accepts multiple reference images', async () => {
    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { text: 'generated' },
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: Buffer.from('png-data').toString('base64'),
                },
              },
            ],
          },
        },
      ],
    });

    const { POST } = await import('../src/app/api/ai/image/generate/route');
    const response = await POST(new Request('http://localhost/api/ai/image/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'banana curry',
        images: [
          { base64: 'abc', mimeType: 'image/jpeg' },
          { base64: 'def', mimeType: 'image/png' },
        ],
      }),
    }));

    expect(mockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-3.1-flash-image-preview',
      config: expect.objectContaining({
        responseModalities: ['TEXT', 'IMAGE'],
      }),
    }));

    const payload = await response.json();
    expect(payload).toMatchObject({
      imageUrl: 'https://example.com/generated.png',
      modelUsed: 'gemini-3.1-flash-image-preview',
      referenceImageCount: 2,
      text: 'generated',
    });
  });

  it('meal-plans PATCH persists imageUrl to the planned_meals image_url column', async () => {
    const storedMeal = {
      id: 'meal-1',
      image_url: 'https://example.com/generated.png',
    };
    mockSingle.mockResolvedValue({ data: storedMeal, error: null });

    const { PATCH } = await import('../src/app/api/meal-plans/meals/[id]/route');
    const response = await PATCH(
      new Request('http://localhost/api/meal-plans/meals/meal-1', {
        method: 'PATCH',
        body: JSON.stringify({
          imageUrl: 'https://example.com/generated.png',
        }),
      }),
      { params: { id: 'meal-1' } },
    );

    expect(mockFrom).toHaveBeenCalledWith('planned_meals');
    expect(mockUpdate).toHaveBeenCalledWith({
      image_url: 'https://example.com/generated.png',
    });
    expect(mockEq).toHaveBeenCalledWith('id', 'meal-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      meal: storedMeal,
    });
  });
});
