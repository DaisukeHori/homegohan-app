import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// ユーザーの全重要メッセージを取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '50');

  try {
    // ユーザーの全セッションから重要メッセージを取得
    const { data, error } = await supabase
      .from('ai_consultation_messages')
      .select(`
        id,
        role,
        content,
        importance_reason,
        created_at,
        ai_consultation_sessions!inner(
          id,
          title,
          user_id
        )
      `)
      .eq('is_important', true)
      .eq('ai_consultation_sessions.user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    const importantMessages = (data || []).map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      reason: m.importance_reason,
      createdAt: m.created_at,
      session: {
        id: m.ai_consultation_sessions.id,
        title: m.ai_consultation_sessions.title,
      },
    }));

    return NextResponse.json({ importantMessages });

  } catch (error: any) {
    console.error('Important messages fetch error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

