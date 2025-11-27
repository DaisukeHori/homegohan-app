import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// コメント一覧取得
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('recipe_comments')
    .select(`
      id,
      content,
      rating,
      created_at,
      user_id,
      user_profiles(nickname)
    `)
    .eq('recipe_id', params.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const comments = (data || []).map((c: any) => ({
    id: c.id,
    content: c.content,
    rating: c.rating,
    userId: c.user_id,
    authorName: c.user_profiles?.nickname || '匿名',
    createdAt: c.created_at,
  }));

  return NextResponse.json({ comments });
}

// コメント追加
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    
    if (!body.content || body.content.trim().length === 0) {
      return NextResponse.json({ error: 'コメントを入力してください' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('recipe_comments')
      .insert({
        recipe_id: params.id,
        user_id: user.id,
        content: body.content.trim(),
        rating: body.rating || null,
      })
      .select(`
        id,
        content,
        rating,
        created_at,
        user_profiles(nickname)
      `)
      .single();

    if (error) throw error;

    const userProfile = data.user_profiles as any;
    return NextResponse.json({ 
      success: true, 
      comment: {
        id: data.id,
        content: data.content,
        rating: data.rating,
        authorName: userProfile?.nickname || '匿名',
        createdAt: data.created_at,
      }
    });

  } catch (error: any) {
    console.error('Comment error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

