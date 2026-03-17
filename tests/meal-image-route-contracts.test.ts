import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock('../src/lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(),
  enqueueMealImageJobs: vi.fn(),
  triggerMealImageJobProcessing: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

import {
  buildDishImagePayload,
  enqueueMealImageJobs,
  triggerMealImageJobProcessing,
} from '../src/lib/meal-image-jobs';
import { PATCH as mealPlansPatch } from '../src/app/api/meal-plans/meals/[id]/route';
import { POST as mealPlansPost } from '../src/app/api/meal-plans/meals/route';

const dishPayloadStub = () => ({
  dishes: [{ name: 'reconciled' }],
  jobs: [
    {
      dishIndex: 0,
      dishName: 'reconciled',
      subjectHash: 'hash-1',
      prompt: 'prompt',
      model: 'gemini',
      triggerSource: 'trigger',
      referenceImageUrls: [],
    },
  ],
  mealCoverImageUrl: 'https://examples.com/dish-cover.png',
});

describe('meal image route contracts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  });

  it('meal-plans PATCH reconciles dishes and enqueues jobs', async () => {
    const payload = dishPayloadStub();
    vi.mocked(buildDishImagePayload).mockResolvedValueOnce(payload);

    const existingMeal = {
      id: 'meal-1',
      dishes: [{ name: 'existing' }],
      image_url: 'https://examples.com/old-cover.png',
      catalog_product_id: null,
      generation_metadata: null,
      user_daily_meals: { user_id: 'user-1' },
    };
    const selectChain: any = {
      select: vi.fn(() => selectChain),
      eq: vi.fn(() => selectChain),
      single: vi.fn().mockResolvedValue({ data: existingMeal, error: null }),
    };
    const updateSelectSingle = vi.fn().mockResolvedValue({ data: { id: 'meal-1' }, error: null });
    const updateChain: any = {
      eq: vi.fn(() => updateChain),
      select: vi.fn(() => ({ single: updateSelectSingle })),
    };
    const update = vi.fn(() => updateChain);

    mockFrom.mockImplementation((table: string) => {
      if (table === 'planned_meals') {
        return { select: selectChain.select, update };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const response = await mealPlansPatch(
      new Request('http://localhost/api/meal-plans/meals/meal-1', {
        method: 'PATCH',
        headers: { 'x-request-id': 'req-1' },
        body: JSON.stringify({ dishes: [{ name: 'new' }], imageUrl: 'manual-cover' }),
      }),
      { params: { id: 'meal-1' } }
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(buildDishImagePayload)).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerSource: 'nextjs:meal-plans/meals/meal-1:PATCH',
        imageUrlOverride: 'manual-cover',
      })
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        dishes: payload.dishes,
        image_url: payload.mealCoverImageUrl,
      })
    );
    expect(vi.mocked(enqueueMealImageJobs)).toHaveBeenCalledWith(
      expect.objectContaining({
        plannedMealId: 'meal-1',
        jobSeeds: payload.jobs,
        requestId: 'req-1',
      })
    );
    expect(vi.mocked(triggerMealImageJobProcessing)).toHaveBeenCalledWith({
      plannedMealId: 'meal-1',
      limit: payload.jobs.length,
    });
  });

  it('meal-plans POST saves reconciled dishes/cover and enqueues jobs', async () => {
    const payload = dishPayloadStub();
    vi.mocked(buildDishImagePayload).mockResolvedValueOnce(payload);

    const existingSelectChain: any = {
      select: vi.fn(() => existingSelectChain),
      eq: vi.fn(() => existingSelectChain),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const insertSelectSingle = vi.fn().mockResolvedValue({ data: { id: 'meal-2' }, error: null });
    const insert = vi.fn(() => ({
      select: vi.fn(() => ({ single: insertSelectSingle })),
    }));
    let userDailyMealsCalls = 0;

    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_daily_meals') {
        userDailyMealsCalls += 1;
        return userDailyMealsCalls === 1 ? existingSelectChain : { insert };
      }
      if (table === 'planned_meals') return { insert };
      throw new Error(`Unexpected table: ${table}`);
    });

    const response = await mealPlansPost(
      new Request('http://localhost/api/meal-plans/meals', {
        method: 'POST',
        headers: { 'x-request-id': 'req-2' },
        body: JSON.stringify({
          dayDate: '2026-03-18',
          mealType: 'lunch',
          mode: 'cook',
          dishName: '手入力',
          dishes: [{ name: 'new' }],
          imageUrl: 'manual-cover',
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        dishes: payload.dishes,
        image_url: payload.mealCoverImageUrl,
      })
    );
    expect(vi.mocked(enqueueMealImageJobs)).toHaveBeenCalledWith(
      expect.objectContaining({
        plannedMealId: 'meal-2',
        jobSeeds: payload.jobs,
        requestId: 'req-2',
      })
    );
    expect(vi.mocked(triggerMealImageJobProcessing)).toHaveBeenCalledWith({
      plannedMealId: 'meal-2',
      limit: payload.jobs.length,
    });
  });
});
