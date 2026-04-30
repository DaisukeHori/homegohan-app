import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// コメント一覧取得 (user_id は公開しない)
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
      user_profiles(nickname)
    `)
    .eq('recipe_id', params.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const comments = (data || []).map((c: any) => ({
    id: c.id,
    content: c.content,
    rating: c.rating,
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

    // #259: content 長さ制限 (1〜5000文字)
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (content.length === 0) {
      return NextResponse.json({ error: 'コメントを入力してください' }, { status: 400 });
    }
    if (content.length > 5000) {
      return NextResponse.json({ error: 'コメントは5000文字以内で入力してください' }, { status: 400 });
    }

    // #260: rating validation (1〜5の整数のみ許可)
    let rating: number | null = null;
    if (body.rating !== undefined && body.rating !== null) {
      const r = Number(body.rating);
      if (!Number.isInteger(r) || r < 1 || r > 5) {
        return NextResponse.json({ error: 'ratingは1〜5の整数で入力してください' }, { status: 400 });
      }
      rating = r;
    }

    const { data, error } = await supabase
      .from('recipe_comments')
      .insert({
        recipe_id: params.id,
        user_id: user.id,
        content,
        rating,
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

