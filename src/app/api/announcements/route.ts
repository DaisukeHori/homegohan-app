import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const supabase = createClient(cookies());
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('mode'); // 'admin' | 'public'

  try {
    let query = supabase.from('announcements').select('*').order('created_at', { ascending: false });

    if (mode === 'public') {
      // 一般公開用
      query = query.eq('is_public', true);
    } else {
      // 管理用：権限チェック
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single();
        
      if (profile?.role !== 'admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ announcements: data });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const supabase = createClient(cookies());

  try {
    // 1. 権限チェック
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // 2. 作成
    const body = await request.json();
    const { title, content, isPublic } = body;

    const { data, error } = await supabase
      .from('announcements')
      .insert({
        title,
        content,
        is_public: isPublic,
        created_by: user.id,
        published_at: isPublic ? new Date().toISOString() : null
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ announcement: data });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}



