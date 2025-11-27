import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// いいね追加
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // 既にいいねしているか確認
    const { data: existing } = await supabase
      .from('recipe_likes')
      .select('user_id')
      .eq('recipe_id', params.id)
      .eq('user_id', user.id)
      .single();

    if (existing) {
      return NextResponse.json({ error: 'Already liked' }, { status: 400 });
    }

    // いいね追加
    const { error: insertError } = await supabase
      .from('recipe_likes')
      .insert({
        recipe_id: params.id,
        user_id: user.id,
      });

    if (insertError) throw insertError;

    // いいね数を更新（手動カウント）
    const { count: likeCount } = await supabase
      .from('recipe_likes')
      .select('*', { count: 'exact', head: true })
      .eq('recipe_id', params.id);
    
    await supabase
      .from('recipes')
      .update({ like_count: likeCount || 0 })
      .eq('id', params.id);

    return NextResponse.json({ success: true, liked: true });

  } catch (error: any) {
    console.error('Like error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// いいね削除
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { error } = await supabase
      .from('recipe_likes')
      .delete()
      .eq('recipe_id', params.id)
      .eq('user_id', user.id);

    if (error) throw error;

    return NextResponse.json({ success: true, liked: false });

  } catch (error: any) {
    console.error('Unlike error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

