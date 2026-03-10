import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

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

    const { data, error } = await supabase.functions.invoke('analyze-meal-photo', {
      body: {
        images: imageDataArray,
        mealId,
        mealType,
        prefetchedGeminiResult,
        userId: user.id,
      },
    });

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

    return NextResponse.json(data);
  } catch (error: any) {
    console.error('Analyze Meal Photo Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
