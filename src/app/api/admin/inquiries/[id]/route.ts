import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// お問い合わせ詳細取得
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 管理者権限確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'super_admin', 'support'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { data, error } = await supabase
    .from('inquiries')
    .select(`
      *,
      user_profiles(nickname, id)
    `)
    .eq('id', params.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    inquiry: {
      id: data.id,
      userId: data.user_id,
      userName: data.user_profiles?.nickname || null,
      inquiryType: data.inquiry_type,
      email: data.email,
      subject: data.subject,
      message: data.message,
      status: data.status,
      adminNotes: data.admin_notes,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      resolvedAt: data.resolved_at,
    },
  });
}

// お問い合わせ更新（ステータス変更、管理者メモ追加）
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 管理者権限確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'super_admin', 'support'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();

    const updateData: any = {
      updated_at: new Date().toISOString(),
    };

    if (body.status) {
      updateData.status = body.status;
      if (body.status === 'resolved') {
        updateData.resolved_at = new Date().toISOString();
      }
    }
    if (body.adminNotes !== undefined) {
      updateData.admin_notes = body.adminNotes;
    }

    const { data, error } = await supabase
      .from('inquiries')
      .update(updateData)
      .eq('id', params.id)
      .select()
      .single();

    if (error) throw error;

    // 監査ログ
    await supabase
      .from('admin_audit_logs')
      .insert({
        admin_id: user.id,
        action: 'update_inquiry',
        target_type: 'inquiry',
        target_id: params.id,
        details: { status: body.status },
        severity: 'info',
      });

    return NextResponse.json({ success: true, inquiry: data });

  } catch (error: any) {
    console.error('Inquiry update error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

