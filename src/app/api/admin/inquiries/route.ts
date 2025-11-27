import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// お問い合わせ一覧取得（管理者用）
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 管理者権限確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', user.id)
    .single();

  if (!profile || !profile?.roles?.some((r: string) => ['admin', 'super_admin', 'support'].includes(r))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  const inquiryType = searchParams.get('type');
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = (page - 1) * limit;

  let dbQuery = supabase
    .from('inquiries')
    .select(`
      *,
      user_profiles(nickname)
    `, { count: 'exact' });

  if (status) {
    dbQuery = dbQuery.eq('status', status);
  }
  if (inquiryType) {
    dbQuery = dbQuery.eq('inquiry_type', inquiryType);
  }

  const { data, error, count } = await dbQuery
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const inquiries = (data || []).map((i: any) => ({
    id: i.id,
    userId: i.user_id,
    userName: i.user_profiles?.nickname || null,
    inquiryType: i.inquiry_type,
    email: i.email,
    subject: i.subject,
    message: i.message,
    status: i.status,
    adminNotes: i.admin_notes,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    resolvedAt: i.resolved_at,
  }));

  return NextResponse.json({
    inquiries,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
}

