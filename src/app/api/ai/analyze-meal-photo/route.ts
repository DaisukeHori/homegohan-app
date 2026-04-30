import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { findCatalogCandidatesForDishes } from '../../../../lib/catalog-products';

interface ImageInput {
  base64: string;
  mimeType: string;
}

interface PrefetchedGeminiResult {
  dishes: Array<{
    name: string;
    role: 'main' | 'side' | 'soup' | 'rice' | 'salad' | 'dessert';
    cookingMethod?: 'fried' | 'grilled' | 'stir_fried' | 'simmered' | 'steamed' | 'boiled' | 'raw' | 'rice' | 'soup' | 'baked' | 'other';
    visiblePortionWeightG?: number;
    visibleIngredients?: Array<{
      name: string;
      amount_g: number;
    }>;
    estimatedIngredients?: Array<{
      name: string;
      amount_g: number;
    }>;
    estimatedNutrition?: {
      calories_kcal: number;
      protein_g: number;
      fat_g: number;
      carbs_g: number;
      fiber_g: number;
      salt_eq_g: number;
      confidence: 'high' | 'medium' | 'low';
    };
  }>;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const startedAt = Date.now();
    const body = await request.json();
    const { images, imageBase64, mimeType, mealType, mealId, prefetchedGeminiResult } = body as {
      images?: ImageInput[];
      imageBase64?: string;
      mimeType?: string;
      mealType?: string;
      mealId?: string;
      prefetchedGeminiResult?: PrefetchedGeminiResult;
    };

    const imageDataArray: ImageInput[] = Array.isArray(images) && images.length > 0
      ? images
      : imageBase64
        ? [{ base64: imageBase64, mimeType: mimeType || 'image/jpeg' }]
        : [];

    if (imageDataArray.length === 0) {
      return NextResponse.json({ error: 'Image is required' }, { status: 400 });
    }

    // #121: タイムアウト後の DB 書き込み防止
    // mealId がある非同期モードでは invokedAt を Edge Function に渡す。
    // Edge Function 側はDB更新前に planned_meals.photo_analyzed_at と比較し、
    // 自分より新しい書き込みが既にある場合は更新をスキップする（CAS パターン）。
    const invokedAt = new Date().toISOString();

    const invokePromise = supabase.functions.invoke('analyze-meal-photo', {
      body: {
        images: imageDataArray,
        mealId,
        mealType,
        prefetchedGeminiResult,
        userId: user.id,
        invokedAt: mealId ? invokedAt : undefined,
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('AI タイムアウト')), 25_000),
    );

    const { data, error } = await Promise.race([invokePromise, timeoutPromise]) as Awaited<typeof invokePromise>;

    if (error) {
      throw new Error(`Edge Function invoke failed: ${error.message}`);
    }

    console.info('Analyze Meal Photo: completed', {
      imageCount: imageDataArray.length,
      mealId: mealId ?? null,
      mealType: mealType ?? null,
      sync: !mealId,
      usedPrefetchedGeminiResult: Boolean(prefetchedGeminiResult?.dishes?.length),
      elapsedMs: Date.now() - startedAt,
      timings: data?.timings ?? null,
    });

    if (mealId) {
      return NextResponse.json({
        success: true,
        message: data?.message || 'Photo analysis started in background',
        status: 'processing',
      });
    }

    const dishNames = Array.isArray(data?.dishes)
      ? data.dishes
          .map((dish: any) => typeof dish?.name === 'string' ? dish.name.trim() : '')
          .filter((name: string) => name.length > 0)
      : [];

    let catalogMatches: Awaited<ReturnType<typeof findCatalogCandidatesForDishes>> = [];
    if (dishNames.length > 0) {
      try {
        catalogMatches = await findCatalogCandidatesForDishes(supabase, dishNames, { limitPerDish: 3 });
      } catch (catalogError) {
        console.warn('Analyze Meal Photo: catalog lookup skipped', catalogError);
      }
    }

    return NextResponse.json({
      ...data,
      catalogMatches,
    });
  } catch (error: any) {
    const isTimeout = error instanceof Error && error.message === 'AI タイムアウト';
    if (isTimeout) {
      console.error('Analyze Meal Photo: AI timeout after 25s');
      return NextResponse.json(
        { error: 'AI が応答しませんでした、もう一度お試しください' },
        { status: 504 },
      );
    }
    console.error('Analyze Meal Photo Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
