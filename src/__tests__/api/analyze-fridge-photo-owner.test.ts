/**
 * #1365 段 1: 冷蔵庫の写真の解析 (POST /api/ai/analyze-fridge) は、写真のバケットの URL を
 * 公開 URL のまま取りに行かず、本人の写真に署名した URL で読む。他人の写真の URL は AI に渡さない。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchImageAsBase64: vi.fn(),
  generateGeminiJson: vi.fn(),
  consumeAiUsage: vi.fn(),
  signCalls: [] as Array<{ bucket: string; paths: string[] }>,
}));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BASE = 'https://proj.supabase.co/storage/v1/object';

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getSupabaseAdmin: () => ({
    from: () => {
      throw new Error('planned_meals should not be read for these paths');
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrls: async (paths: string[]) => {
          mocks.signCalls.push({ bucket, paths });
          return { data: paths.map((path) => ({ path, error: null, signedUrl: `${BASE}/sign/${bucket}/${path}?token=t` })), error: null };
        },
      }),
    },
  }),
}));

vi.mock('@/lib/ai/consent-guard', () => ({ requireAiConsent: async () => null }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ success: true }),
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/plan/entitlements', () => ({
  AI_USAGE_COVERED_BY_GRANT: { allowed: true },
  aiDailyLimitResponse: vi.fn(),
  consumeAiUsage: (...args: unknown[]) => mocks.consumeAiUsage(...args),
  redeemAiUsageGrant: async () => false,
}));
vi.mock('../../lib/ai/gemini-json', () => ({
  fetchImageAsBase64: (...args: unknown[]) => mocks.fetchImageAsBase64(...args),
  generateGeminiJson: (...args: unknown[]) => mocks.generateGeminiJson(...args),
}));

import { POST } from '@/app/api/ai/analyze-fridge/route';

function request(body: unknown): Request {
  return new Request('http://localhost/api/ai/analyze-fridge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/ai/analyze-fridge (写真の URL)', () => {
  beforeEach(() => {
    mocks.fetchImageAsBase64.mockReset();
    mocks.generateGeminiJson.mockReset();
    mocks.consumeAiUsage.mockReset();
    mocks.signCalls.length = 0;
    mocks.fetchImageAsBase64.mockResolvedValue({ base64: 'aGVsbG8=', mimeType: 'image/jpeg' });
    mocks.consumeAiUsage.mockResolvedValue({ allowed: true });
    mocks.generateGeminiJson.mockResolvedValue({
      data: { ingredients: [{ name: 'キャベツ' }], summary: 's', suggestions: [] },
      model: 'm',
    });
  });

  it('本人の写真は、署名した URL で読む (公開 URL では取りに行かない)', async () => {
    const own = `${BASE}/public/fridge-images/${USER}/fridge.jpg`;
    const res = await POST(request({ imageUrl: own }));
    expect(res.status).toBe(200);
    expect(mocks.fetchImageAsBase64).toHaveBeenCalledWith(`${BASE}/sign/fridge-images/${USER}/fridge.jpg?token=t`);
    expect(mocks.signCalls).toEqual([{ bucket: 'fridge-images', paths: [`${USER}/fridge.jpg`] }]);
  });

  it('inventoryImageUrl (別名) でも同じ', async () => {
    const own = `${BASE}/public/fridge-images/${USER}/fridge.jpg`;
    const res = await POST(request({ inventoryImageUrl: own }));
    expect(res.status).toBe(200);
    expect(mocks.fetchImageAsBase64).toHaveBeenCalledWith(`${BASE}/sign/fridge-images/${USER}/fridge.jpg?token=t`);
  });

  it('他人の写真の URL は 403 で、読まない・AI に渡さない・回数も数えない', async () => {
    const others = `${BASE}/public/fridge-images/${OTHER}/fridge.jpg`;
    const res = await POST(request({ imageUrl: others }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'PHOTO_NOT_READABLE' });
    expect(mocks.fetchImageAsBase64).not.toHaveBeenCalled();
    expect(mocks.generateGeminiJson).not.toHaveBeenCalled();
    expect(mocks.consumeAiUsage).not.toHaveBeenCalled();
    expect(mocks.signCalls).toEqual([]);
  });
});
