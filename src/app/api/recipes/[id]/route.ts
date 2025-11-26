import { createClient } from '@/lib/supabase/server';

import { NextResponse } from 'next/server';

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('recipes')
    .select('*')
    .eq('id', params.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 権限チェック（自分のものか、パブリックか）
  if (data.user_id !== user.id && !data.is_public) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const recipe = {
    id: data.id,
    userId: data.user_id,
    name: data.name,
    description: data.description,
    caloriesKcal: data.calories_kcal,
    cookingTimeMinutes: data.cooking_time_minutes,
    servings: data.servings,
    imageUrl: data.image_url,
    ingredients: data.ingredients,
    steps: data.steps,
    isPublic: data.is_public,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };

  return NextResponse.json({ recipe });
}


