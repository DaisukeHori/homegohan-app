import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const supabase = createClient(cookies());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  let dbQuery = supabase
    .from('recipes')
    .select('*')
    .or(`user_id.eq.${user.id},is_public.eq.true`);

  if (query) {
    dbQuery = dbQuery.ilike('name', `%${query}%`);
  }

  const { data, error } = await dbQuery.order('created_at', { ascending: false }).limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // キャメルケース変換
  const recipes = data.map((item: any) => ({
    id: item.id,
    userId: item.user_id,
    name: item.name,
    description: item.description,
    caloriesKcal: item.calories_kcal,
    cookingTimeMinutes: item.cooking_time_minutes,
    servings: item.servings,
    imageUrl: item.image_url,
    ingredients: item.ingredients,
    steps: item.steps,
    isPublic: item.is_public,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }));

  return NextResponse.json({ recipes });
}


