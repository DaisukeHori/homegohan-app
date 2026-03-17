import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/catalog-products', () => ({
  buildCatalogSelectionUpdate: vi.fn(),
  clearCatalogSelectionMetadata: vi.fn(),
}));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const supabaseClient = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => supabaseClient,
}));

import {
  buildCatalogSelectionUpdate,
  clearCatalogSelectionMetadata,
} from '../lib/catalog-products';
import { POST as mealsPOST } from '../src/app/api/meals/route';
import { PATCH as mealPlansPatch } from '../src/app/api/meal-plans/meals/[id]/route';

describe('catalog meal persistence routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  });

  it('meals POST persists catalog selection fields when catalogProductId is provided', async () => {
    const upsert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: 'daily-1' }, error: null }),
      }),
    });
    const insertedMeal = {
      id: 'meal-1',
      daily_meal_id: 'daily-1',
      meal_type: 'lunch',
      mode: 'buy',
      dish_name: '公開商品弁当',
      is_simple: true,
      dishes: null,
      calories_kcal: 540,
      description: '公開商品',
      ingredients: null,
      is_completed: false,
      created_at: '2026-03-17T00:00:00.000Z',
      updated_at: '2026-03-17T00:00:00.000Z',
    };
    const insert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: insertedMeal, error: null }),
      }),
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_daily_meals') return { upsert };
      if (table === 'planned_meals') return { insert };
      throw new Error(`Unexpected table: ${table}`);
    });

    vi.mocked(buildCatalogSelectionUpdate).mockResolvedValue({
      product: {} as never,
      fields: {
        catalog_product_id: 'catalog-1',
        source_type: 'catalog_product',
        dish_name: '公開商品弁当',
        calories_kcal: 540,
        generation_metadata: {
          catalog_selection: { active: true, productId: 'catalog-1' },
        },
      },
    });

    const response = await mealsPOST(new Request('http://localhost/api/meals', {
      method: 'POST',
      body: JSON.stringify({
        date: '2026-03-17',
        mealType: 'lunch',
        dishName: '手入力名',
        mode: 'buy',
        catalogProductId: 'catalog-1',
      }),
    }));

    expect(buildCatalogSelectionUpdate).toHaveBeenCalledWith({
      supabase: supabaseClient,
      catalogProductId: 'catalog-1',
      mode: 'buy',
      imageUrl: undefined,
      description: undefined,
      selectedFrom: 'manual_search',
    });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      daily_meal_id: 'daily-1',
      meal_type: 'lunch',
      catalog_product_id: 'catalog-1',
      source_type: 'catalog_product',
      dish_name: '公開商品弁当',
      generation_metadata: {
        catalog_selection: { active: true, productId: 'catalog-1' },
      },
    }));
    await expect(response.json()).resolves.toEqual({
      meal: insertedMeal,
    });
  });

  it('meal-plans PATCH applies catalog fields when selecting a catalog product', async () => {
    const existingMeal = {
      id: 'meal-1',
      mode: 'buy',
      catalog_product_id: null,
      source_type: 'manual',
      generation_metadata: null,
      user_daily_meals: { user_id: 'user-1' },
    };
    const updatedMeal = { id: 'meal-1', catalog_product_id: 'catalog-1', source_type: 'catalog_product' };

    const select = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: existingMeal, error: null }),
        }),
      }),
    });
    const update = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: updatedMeal, error: null }),
        }),
      }),
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'planned_meals') return { select, update };
      throw new Error(`Unexpected table: ${table}`);
    });

    vi.mocked(buildCatalogSelectionUpdate).mockResolvedValue({
      product: {} as never,
      fields: {
        catalog_product_id: 'catalog-1',
        source_type: 'catalog_product',
        dish_name: '公開商品弁当',
        generation_metadata: {
          catalog_selection: { active: true, productId: 'catalog-1' },
        },
      },
    });

    const response = await mealPlansPatch(
      new Request('http://localhost/api/meal-plans/meals/meal-1', {
        method: 'PATCH',
        body: JSON.stringify({
          catalogProductId: 'catalog-1',
          mode: 'buy',
          description: '公開商品',
        }),
      }),
      { params: { id: 'meal-1' } },
    );

    expect(buildCatalogSelectionUpdate).toHaveBeenCalledWith({
      supabase: supabaseClient,
      catalogProductId: 'catalog-1',
      existingMetadata: null,
      mode: 'buy',
      imageUrl: undefined,
      description: '公開商品',
      selectedFrom: 'manual_search',
    });
    expect(update).toHaveBeenCalledWith({
      catalog_product_id: 'catalog-1',
      source_type: 'catalog_product',
      dish_name: '公開商品弁当',
      generation_metadata: {
        catalog_selection: { active: true, productId: 'catalog-1' },
      },
      mode: 'buy',
      description: '公開商品',
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      meal: updatedMeal,
    });
  });

  it('meal-plans PATCH clears catalog linkage when manual content overrides an existing catalog meal', async () => {
    const existingMeal = {
      id: 'meal-1',
      mode: 'buy',
      catalog_product_id: 'catalog-1',
      source_type: 'catalog_product',
      generation_metadata: {
        catalog_selection: { active: true, productId: 'catalog-1' },
      },
      user_daily_meals: { user_id: 'user-1' },
    };
    const updatedMeal = { id: 'meal-1', catalog_product_id: null, source_type: 'manual' };

    const select = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: existingMeal, error: null }),
        }),
      }),
    });
    const update = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: updatedMeal, error: null }),
        }),
      }),
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'planned_meals') return { select, update };
      throw new Error(`Unexpected table: ${table}`);
    });

    vi.mocked(clearCatalogSelectionMetadata).mockReturnValue({
      catalog_selection: { active: false, clearReason: 'manual_override' },
    });

    const response = await mealPlansPatch(
      new Request('http://localhost/api/meal-plans/meals/meal-1', {
        method: 'PATCH',
        body: JSON.stringify({
          dishName: '手入力どんぶり',
          description: '手入力へ変更',
        }),
      }),
      { params: { id: 'meal-1' } },
    );

    expect(clearCatalogSelectionMetadata).toHaveBeenCalledWith(
      existingMeal.generation_metadata,
      'manual_override',
    );
    expect(update).toHaveBeenCalledWith({
      dish_name: '手入力どんぶり',
      description: '手入力へ変更',
      catalog_product_id: null,
      source_type: 'manual',
      generation_metadata: {
        catalog_selection: { active: false, clearReason: 'manual_override' },
      },
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      meal: updatedMeal,
    });
  });
});
