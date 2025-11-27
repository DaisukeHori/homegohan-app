import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// お知らせ更新
export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
    const updateData: any = { updated_at: new Date().toISOString() };

    if (body.title !== undefined) updateData.title = body.title;
    if (body.content !== undefined) updateData.content = body.content;
    if (body.category !== undefined) updateData.category = body.category;
    if (body.priority !== undefined) updateData.priority = body.priority;
    if (body.targetAudience !== undefined) updateData.target_audience = body.targetAudience;
    if (body.isPublic !== undefined) updateData.is_public = body.isPublic;
    if (body.imageUrl !== undefined) updateData.image_url = body.imageUrl;
    if (body.publishedAt !== undefined) updateData.published_at = body.publishedAt;
    if (body.expiresAt !== undefined) updateData.expires_at = body.expiresAt;

    const { error } = await supabase
      .from('announcements')
      .update(updateData)
      .eq('id', params.id);

    if (error) throw error;

    // 監査ログ
    await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: user.id,
        action_type: 'update_announcement',
        target_id: params.id,
        details: { updates: Object.keys(updateData) },
      });

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// お知らせ削除
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'super_admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    // まず既読データを削除
    await supabase
      .from('announcement_reads')
      .delete()
      .eq('announcement_id', params.id);

    // お知らせ削除
    const { error } = await supabase
      .from('announcements')
      .delete()
      .eq('id', params.id);

    if (error) throw error;

    // 監査ログ
    await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: user.id,
        action_type: 'delete_announcement',
        target_id: params.id,
      });

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

