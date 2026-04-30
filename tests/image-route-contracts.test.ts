import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.fn();
const mockInvoke = vi.fn();
const mockUpload = vi.fn();
const mockGetPublicUrl = vi.fn();
const mockGenerateContent = vi.fn();
const mockFrom = vi.fn();
const mockUpdate = vi.fn();
const mockEq = vi.fn();
const mockNeq = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();
const mockOr = vi.fn();
const mockSelect = vi.fn();
const mockSingle = vi.fn();
let selectChainData: any[] = [];
let selectChainError: { message: string } | null = null;

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
    selectChainData = [];
    selectChainError = null;
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockInvoke.mockReset();
    mockUpload.mockResolvedValue({ error: null });
    mockGetPublicUrl.mockReturnValue({ data: { publicUrl: 'https://example.com/generated.png' } });
    mockGenerateContent.mockReset();
    const selectChain = {
      get data() {
        return selectChainData;
      },
      get error() {
        return selectChainError;
      },
      eq: mockEq,
      neq: mockNeq,
      order: mockOrder,
      limit: mockLimit,
      or: mockOr,
      select: mockSelect,
      single: mockSingle,
      maybeSingle: mockSingle,
    };
    const updateChain = {
      eq: mockEq,
      select: mockSelect,
    };

    mockSingle.mockResolvedValue({ data: { id: 'meal-1' }, error: null });
    mockSelect.mockImplementation(() => selectChain as any);
    mockEq.mockImplementation(() => selectChain as any);
    mockNeq.mockImplementation(() => selectChain as any);
    mockOrder.mockImplementation(() => selectChain as any);
    mockLimit.mockImplementation(() => selectChain as any);
    mockOr.mockImplementation(() => selectChain as any);
    mockUpdate.mockImplementation(() => updateChain as any);
    mockFrom.mockImplementation(() => ({
      update: mockUpdate,
      select: mockSelect,
      eq: mockEq,
      neq: mockNeq,
      order: mockOrder,
      limit: mockLimit,
      or: mockOr,
      data: [],
      error: null,
    }));
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
      catalogMatches: [],
    });
  });

  it('analyze-meal-photo forwards prefetched Gemini meal analysis when provided', async () => {
    const prefetchedGeminiResult = {
      dishes: [
        {
          name: '親子丼',
          role: 'main',
          cookingMethod: 'simmered',
          visiblePortionWeightG: 260,
          visibleIngredients: [
            { name: '鶏もも肉', amount_g: 120 },
            { name: '卵', amount_g: 60 },
          ],
        },
      ],
    };

    mockInvoke.mockResolvedValue({
      data: {
        dishes: [{ name: '親子丼', role: 'main', cal: 640 }],
        totalCalories: 640,
      },
      error: null,
    });

    const { POST } = await import('../src/app/api/ai/analyze-meal-photo/route');
    const response = await POST(new Request('http://localhost/api/ai/analyze-meal-photo', {
      method: 'POST',
      body: JSON.stringify({
        images: [{ base64: 'abc', mimeType: 'image/jpeg' }],
        mealType: 'dinner',
        prefetchedGeminiResult,
      }),
    }));

    expect(mockInvoke).toHaveBeenCalledWith('analyze-meal-photo', {
      body: {
        images: [{ base64: 'abc', mimeType: 'image/jpeg' }],
        mealId: undefined,
        mealType: 'dinner',
        prefetchedGeminiResult,
        userId: 'user-1',
      },
    });
    await expect(response.json()).resolves.toEqual({
      dishes: [{ name: '親子丼', role: 'main', cal: 640 }],
      totalCalories: 640,
      catalogMatches: [],
    });
  });

  it('analyze-meal-photo attaches catalog matches for returned dishes', async () => {
    mockInvoke.mockResolvedValue({
      data: {
        dishes: [{ name: '親子丼', role: 'main', cal: 640 }],
        totalCalories: 640,
      },
      error: null,
    });
    selectChainData = [
      {
        id: 'catalog-1',
        source_id: 'source-1',
        name: '親子丼',
        brand_name: 'FamilyMart',
        category_code: 'bento',
        description: '定番の親子丼',
        main_image_url: 'https://example.com/oyakodon.png',
        canonical_url: 'https://example.com/products/catalog-1',
        price_yen: 598,
        calories_kcal: 640,
        protein_g: 28.4,
        fat_g: 18.2,
        carbs_g: 82.1,
        sodium_g: 1.9,
        fiber_g: 3.2,
        sugar_g: 6.4,
        availability_status: 'active',
        updated_at: '2026-03-17T10:00:00.000Z',
        catalog_sources: {
          code: 'familymart',
          brand_name: 'FamilyMart',
        },
      },
    ];

    const { POST } = await import('../src/app/api/ai/analyze-meal-photo/route');
    const response = await POST(new Request('http://localhost/api/ai/analyze-meal-photo', {
      method: 'POST',
      body: JSON.stringify({
        images: [{ base64: 'abc', mimeType: 'image/jpeg' }],
        mealType: 'dinner',
      }),
    }));

    await expect(response.json()).resolves.toEqual({
      dishes: [{ name: '親子丼', role: 'main', cal: 640 }],
      totalCalories: 640,
      catalogMatches: [
        {
          dishName: '親子丼',
          candidates: [
            expect.objectContaining({
              id: 'catalog-1',
              name: '親子丼',
              brandName: 'FamilyMart',
              sourceCode: 'familymart',
              caloriesKcal: 640,
            }),
          ],
        },
      ],
    });
  });

  it('analyze-meal-photo keeps response successful when catalog lookup fails', async () => {
    mockInvoke.mockResolvedValue({
      data: {
        dishes: [{ name: 'カレー', role: 'main', cal: 620 }],
        totalCalories: 620,
      },
      error: null,
    });
    selectChainError = { message: 'catalog lookup failed' };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { POST } = await import('../src/app/api/ai/analyze-meal-photo/route');
    const response = await POST(new Request('http://localhost/api/ai/analyze-meal-photo', {
      method: 'POST',
      body: JSON.stringify({
        images: [{ base64: 'abc', mimeType: 'image/jpeg' }],
        mealType: 'dinner',
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      dishes: [{ name: 'カレー', role: 'main', cal: 620 }],
      totalCalories: 620,
      catalogMatches: [],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Analyze Meal Photo: catalog lookup skipped',
      expect.any(Error),
    );
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
      description: '冷蔵庫の写真と判定しました',
      modelUsed: 'gemini-3.1-flash-lite-preview',
    });
    expect(payload.candidates).toEqual([
      { type: 'fridge', confidence: 0.88 },
    ]);

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.contents[0].parts).toHaveLength(3);
    expect(requestBody.generationConfig.responseMimeType).toBe('application/json');
  });

  it('classify-photo can return prefetched meal analysis for auto mode', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    type: 'meal',
                    confidence: 0.93,
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
                    dishes: [
                      {
                        name: '牛ステーキ',
                        role: 'main',
                        cookingMethod: 'grilled',
                        visiblePortionWeightG: 220,
                        visibleIngredients: [
                          { name: '牛肉', amount_g: 180 },
                          { name: '赤ワイン', amount_g: 20 },
                        ],
                      },
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
        images: [{ base64: 'abc', mimeType: 'image/jpeg' }],
        includeMealAnalysis: true,
        mealType: 'dinner',
      }),
    }));

    const payload = await response.json();
    expect(payload).toMatchObject({
      type: 'meal',
      confidence: 0.93,
      modelUsed: 'gemini-3.1-flash-lite-preview',
      mealAnalysis: {
        dishes: [
          {
            name: '牛ステーキ',
            role: 'main',
            cookingMethod: 'grilled',
            visiblePortionWeightG: 220,
            visibleIngredients: [
              { name: '牛肉', amount_g: 180 },
              { name: '赤ワイン', amount_g: 20 },
            ],
            estimatedIngredients: [
              { name: '牛肉', amount_g: 180 },
              { name: '赤ワイン', amount_g: 20 },
            ],
          },
        ],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const classifyRequestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(classifyRequestBody.generationConfig.responseJsonSchema.properties.type).toBeDefined();
    expect(classifyRequestBody.generationConfig.responseJsonSchema.properties.mealAnalysis).toBeUndefined();

    const mealAnalysisRequestBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(mealAnalysisRequestBody.generationConfig.responseJsonSchema.properties.dishes).toBeDefined();
  });

  it('classify-photo retries with higher temperature when the batch result is weak', async () => {
    // 1回目: unknown (confidence 低い) → retry 2回 → meal が返る
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
    // リトライで meal 0.81 が採用される (unknown より高信頼)
    await expect(response.json()).resolves.toMatchObject({
      type: 'meal',
      confidence: 0.81,
    });
    // 初回 1 回 + リトライ 2 回 = 3 回
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
                  text: '{"type":"meal","confidence":0.99',
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
      confidence: 1,
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
