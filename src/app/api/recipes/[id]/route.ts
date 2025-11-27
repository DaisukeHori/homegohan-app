import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// レシピ詳細取得
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // 閲覧数をインクリメント
  try {
    const { data: currentRecipe } = await supabase
      .from('recipes')
      .select('view_count')
      .eq('id', params.id)
      .single();
    
    if (currentRecipe) {
      await supabase
        .from('recipes')
        .update({ view_count: (currentRecipe.view_count || 0) + 1 })
        .eq('id', params.id);
    }
  } catch (e) {
    // 閲覧数更新エラーは無視
  }

  const { data, error } = await supabase
    .from('recipes')
    .select(`
      *,
      user_profiles(nickname, id),
      recipe_likes(user_id),
      recipe_comments(
        id,
        content,
        rating,
        created_at,
        user_profiles(nickname)
      )
    `)
    .eq('id', params.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // 非公開レシピは作成者のみ閲覧可能
  if (!data.is_public && data.user_id !== user?.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const recipe = {
    id: data.id,
    userId: data.user_id,
    authorName: data.user_profiles?.nickname || '匿名',
    name: data.name,
    description: data.description,
    caloriesKcal: data.calories_kcal,
    cookingTimeMinutes: data.cooking_time_minutes,
    servings: data.servings,
    imageUrl: data.image_url,
    ingredients: data.ingredients,
    steps: data.steps,
    isPublic: data.is_public,
    category: data.category,
    cuisineType: data.cuisine_type,
    difficulty: data.difficulty,
    tags: data.tags || [],
    nutrition: data.nutrition,
    tips: data.tips,
    videoUrl: data.video_url,
    sourceUrl: data.source_url,
    viewCount: data.view_count || 0,
    likeCount: data.like_count || 0,
    isLiked: user ? data.recipe_likes?.some((l: any) => l.user_id === user.id) : false,
    isOwner: user?.id === data.user_id,
    comments: (data.recipe_comments || []).map((c: any) => ({
      id: c.id,
      content: c.content,
      rating: c.rating,
      authorName: c.user_profiles?.nickname || '匿名',
      createdAt: c.created_at,
    })),
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };

  return NextResponse.json({ recipe });
}

// レシピ更新
export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // 所有者確認
    const { data: existing } = await supabase
      .from('recipes')
      .select('user_id')
      .eq('id', params.id)
      .single();

    if (!existing || existing.user_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    
    const updateData: any = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.description !== undefined) updateData.description = body.description;
    if (body.caloriesKcal !== undefined) updateData.calories_kcal = body.caloriesKcal;
    if (body.cookingTimeMinutes !== undefined) updateData.cooking_time_minutes = body.cookingTimeMinutes;
    if (body.servings !== undefined) updateData.servings = body.servings;
    if (body.imageUrl !== undefined) updateData.image_url = body.imageUrl;
    if (body.ingredients !== undefined) updateData.ingredients = body.ingredients;
    if (body.steps !== undefined) updateData.steps = body.steps;
    if (body.isPublic !== undefined) updateData.is_public = body.isPublic;
    if (body.category !== undefined) updateData.category = body.category;
    if (body.cuisineType !== undefined) updateData.cuisine_type = body.cuisineType;
    if (body.difficulty !== undefined) updateData.difficulty = body.difficulty;
    if (body.tags !== undefined) updateData.tags = body.tags;
    if (body.nutrition !== undefined) updateData.nutrition = body.nutrition;
    if (body.tips !== undefined) updateData.tips = body.tips;
    if (body.videoUrl !== undefined) updateData.video_url = body.videoUrl;

    const { data, error } = await supabase
      .from('recipes')
      .update(updateData)
      .eq('id', params.id)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, recipe: data });

  } catch (error: any) {
    console.error('Recipe update error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// レシピ削除
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // 所有者確認
    const { data: existing } = await supabase
      .from('recipes')
      .select('user_id')
      .eq('id', params.id)
      .single();

    if (!existing || existing.user_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { error } = await supabase
      .from('recipes')
      .delete()
      .eq('id', params.id);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('Recipe delete error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
