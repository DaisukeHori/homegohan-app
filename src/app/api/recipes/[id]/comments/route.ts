import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { recipeAuthorName } from '@/lib/recipes/author-name';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';

// コメント一覧取得 (user_id は公開しない)
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient();

  // 未認証は 401
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

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

  if (error) return internalError('GET /api/recipes/[id]/comments', error, { userId: user.id });

  const comments = (data || []).map((c: any) => ({
    id: c.id,
    content: c.content,
    rating: c.rating,
    authorName: recipeAuthorName(c.user_profiles?.nickname),
    createdAt: c.created_at,
  }));

  return NextResponse.json({ comments });
}

// コメント追加
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

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

    const userProfileRaw = data.user_profiles as { nickname: string | null } | { nickname: string | null }[] | null;
    const userProfile = Array.isArray(userProfileRaw) ? userProfileRaw[0] ?? null : userProfileRaw;
    return NextResponse.json({
      success: true,
      comment: {
        id: data.id,
        content: data.content,
        rating: data.rating,
        authorName: recipeAuthorName(userProfile?.nickname),
        createdAt: data.created_at,
      }
    });

  } catch (error: any) {
    return internalError('POST /api/recipes/[id]/comments', error, { userId: user.id });
  }
}

