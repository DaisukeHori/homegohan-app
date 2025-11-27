import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// お知らせ一覧取得（管理者用）
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 管理者権限確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'super_admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const includeUnpublished = searchParams.get('include_unpublished') === 'true';

  let query = supabase
    .from('announcements')
    .select('*')
    .order('created_at', { ascending: false });

  if (!includeUnpublished) {
    query = query.eq('is_public', true);
  }

  const { data, error } = await query.limit(100);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const announcements = (data || []).map((a: any) => ({
    id: a.id,
    title: a.title,
    content: a.content,
    category: a.category,
    priority: a.priority,
    targetAudience: a.target_audience,
    isPublic: a.is_public,
    imageUrl: a.image_url,
    publishedAt: a.published_at,
    expiresAt: a.expires_at,
    createdAt: a.created_at,
  }));

  return NextResponse.json({ announcements });
}

// お知らせ作成
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 管理者権限確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'super_admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();

    if (!body.title || !body.content) {
      return NextResponse.json({ error: 'タイトルと内容は必須です' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('announcements')
      .insert({
        title: body.title,
        content: body.content,
        category: body.category || 'general',
        priority: body.priority || 0,
        target_audience: body.targetAudience || 'all',
        is_public: body.isPublic ?? true,
        image_url: body.imageUrl || null,
        published_at: body.publishedAt || new Date().toISOString(),
        expires_at: body.expiresAt || null,
      })
      .select()
      .single();

    if (error) throw error;

    // 監査ログ
    await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: user.id,
        action: 'create_announcement',
        target_type: 'announcement',
        target_id: data.id,
        details: { title: body.title },
        severity: 'info',
      });

    return NextResponse.json({
      success: true,
      announcement: {
        id: data.id,
        title: data.title,
        createdAt: data.created_at,
      },
    });

  } catch (error: any) {
    console.error('Announcement creation error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

