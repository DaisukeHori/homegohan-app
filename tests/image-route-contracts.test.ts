import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.fn();
const mockInvoke = vi.fn();
const mockUpload = vi.fn();
const mockGetPublicUrl = vi.fn();
const mockGenerateContent = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    functions: { invoke: mockInvoke },
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
      modelUsed: 'gemini-3-pro-preview',
    });
    expect(payload.candidates).toEqual([
      { type: 'fridge', confidence: 0.88 },
      { type: 'meal', confidence: 0.33 },
    ]);

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.contents[0].parts).toHaveLength(3);
    expect(requestBody.generationConfig.responseMimeType).toBe('application/json');
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
});
