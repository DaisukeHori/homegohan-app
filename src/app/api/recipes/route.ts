import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// レシピ一覧取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const category = searchParams.get('category');
  const cuisineType = searchParams.get('cuisine_type');
  const difficulty = searchParams.get('difficulty');
  const maxTime = searchParams.get('max_time');
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '20');
  const offset = (page - 1) * limit;

  let dbQuery = supabase
    .from('recipes')
    .select(`
      *,
      user_profiles(nickname),
      recipe_likes(user_id)
    `, { count: 'exact' });

  // 公開レシピ、または自分のレシピ
  if (user) {
    dbQuery = dbQuery.or(`is_public.eq.true,user_id.eq.${user.id}`);
  } else {
    dbQuery = dbQuery.eq('is_public', true);
  }

  // フィルター
  if (query) {
    dbQuery = dbQuery.or(`name.ilike.%${query}%,description.ilike.%${query}%`);
  }
  if (category) {
    dbQuery = dbQuery.eq('category', category);
  }
  if (cuisineType) {
    dbQuery = dbQuery.eq('cuisine_type', cuisineType);
  }
  if (difficulty) {
    dbQuery = dbQuery.eq('difficulty', difficulty);
  }
  if (maxTime) {
    dbQuery = dbQuery.lte('cooking_time_minutes', parseInt(maxTime));
  }

  const { data, error, count } = await dbQuery
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // キャメルケース変換
  const recipes = (data || []).map((item: any) => ({
    id: item.id,
    userId: item.user_id,
    authorName: item.user_profiles?.nickname || '匿名',
    name: item.name,
    description: item.description,
    caloriesKcal: item.calories_kcal,
    cookingTimeMinutes: item.cooking_time_minutes,
    servings: item.servings,
    imageUrl: item.image_url,
    ingredients: item.ingredients,
    steps: item.steps,
    isPublic: item.is_public,
    category: item.category,
    cuisineType: item.cuisine_type,
    difficulty: item.difficulty,
    tags: item.tags || [],
    nutrition: item.nutrition,
    tips: item.tips,
    videoUrl: item.video_url,
    viewCount: item.view_count || 0,
    likeCount: item.like_count || 0,
    isLiked: user ? item.recipe_likes?.some((l: any) => l.user_id === user.id) : false,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }));

  return NextResponse.json({ 
    recipes,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    }
  });
}

// レシピ作成
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    
    const recipeData = {
      user_id: user.id,
      name: body.name,
      description: body.description || null,
      calories_kcal: body.caloriesKcal || null,
      cooking_time_minutes: body.cookingTimeMinutes || null,
      servings: body.servings || 2,
      image_url: body.imageUrl || null,
      ingredients: body.ingredients || [],
      steps: body.steps || [],
      is_public: body.isPublic ?? false,
      category: body.category || 'main',
      cuisine_type: body.cuisineType || 'japanese',
      difficulty: body.difficulty || 'easy',
      tags: body.tags || [],
      nutrition: body.nutrition || null,
      tips: body.tips || null,
      video_url: body.videoUrl || null,
      source_url: body.sourceUrl || null,
    };

    const { data, error } = await supabase
      .from('recipes')
      .insert(recipeData)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ 
      success: true, 
      recipe: {
        id: data.id,
        name: data.name,
        createdAt: data.created_at,
      }
    });

  } catch (error: any) {
    console.error('Recipe creation error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}


