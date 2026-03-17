import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import {
  buildCatalogSelectionUpdate,
  clearCatalogSelectionMetadata,
} from '../../../../../lib/catalog-products';

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const json = await request.json();
    const {
      isCompleted,
      dishName,
      mode,
      dishes,
      isSimple,
      caloriesKcal,
      description,
      imageUrl,
      catalogProductId,
      sourceType,
    } = json;

    const { data: existingMeal, error: existingMealError } = await supabase
      .from('planned_meals')
      .select(`
        id,
        mode,
        catalog_product_id,
        source_type,
        generation_metadata,
        user_daily_meals!inner(user_id)
      `)
      .eq('id', params.id)
      .eq('user_daily_meals.user_id', user.id)
      .single();

    if (existingMealError || !existingMeal) {
      return NextResponse.json({ error: 'Not found or unauthorized' }, { status: 404 });
    }

    const updateData: Record<string, any> = {};
    
    if (isCompleted !== undefined) {
      updateData.is_completed = isCompleted;
      updateData.completed_at = isCompleted ? new Date().toISOString() : null;
    }
    if (dishName !== undefined) updateData.dish_name = dishName;
    if (mode !== undefined) updateData.mode = mode;
    if (dishes !== undefined) updateData.dishes = dishes;
    if (isSimple !== undefined) updateData.is_simple = isSimple;
    if (caloriesKcal !== undefined) updateData.calories_kcal = caloriesKcal;
    if (description !== undefined) updateData.description = description;
    if (imageUrl !== undefined) updateData.image_url = imageUrl;

    if (catalogProductId) {
      const { fields } = await buildCatalogSelectionUpdate({
        supabase,
        catalogProductId,
        existingMetadata: existingMeal.generation_metadata,
        mode: mode ?? existingMeal.mode ?? 'buy',
        imageUrl: imageUrl ?? undefined,
        description: description ?? undefined,
        selectedFrom: 'manual_search',
      });
      Object.assign(updateData, fields);
    } else {
      const manualContentChanged =
        dishName !== undefined ||
        dishes !== undefined ||
        isSimple !== undefined ||
        caloriesKcal !== undefined ||
        description !== undefined ||
        imageUrl !== undefined;

      if ((catalogProductId === null || manualContentChanged) && existingMeal.catalog_product_id) {
        updateData.catalog_product_id = null;
        updateData.source_type = sourceType ?? 'manual';
        updateData.generation_metadata = clearCatalogSelectionMetadata(
          existingMeal.generation_metadata,
          catalogProductId === null ? 'catalog_selection_removed' : 'manual_override',
        );
      } else if (sourceType !== undefined) {
        updateData.source_type = sourceType;
      }
    }

    const { data, error } = await supabase
      .from('planned_meals')
      .update(updateData)
      .eq('id', existingMeal.id)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, meal: data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { error } = await supabase
      .from('planned_meals')
      .delete()
      .eq('id', params.id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
