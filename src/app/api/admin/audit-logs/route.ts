import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 監査ログ一覧取得
export async function GET(request: Request) {
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
    const { searchParams } = new URL(request.url);
    const actionType = searchParams.get('action_type');
    const adminId = searchParams.get('admin_id');
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = (page - 1) * limit;

    let query = supabase
      .from('admin_audit_logs')
      .select(`
        id,
        admin_id,
        action_type,
        target_id,
        details,
        ip_address,
        user_agent,
        severity,
        created_at
      `, { count: 'exact' });

    if (actionType) {
      query = query.eq('action_type', actionType);
    }
    if (adminId) {
      query = query.eq('admin_id', adminId);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // 管理者情報を取得
    const adminIds = [...new Set((data || []).map((d: any) => d.admin_id).filter(Boolean))];
    const { data: admins } = await supabase
      .from('user_profiles')
      .select('id, nickname')
      .in('id', adminIds);

    const adminMap = new Map((admins || []).map((a: any) => [a.id, a.nickname]));

    const logs = (data || []).map((log: any) => ({
      id: log.id,
      adminId: log.admin_id,
      adminName: adminMap.get(log.admin_id) || 'Unknown',
      actionType: log.action_type,
      targetId: log.target_id,
      details: log.details,
      ipAddress: log.ip_address,
      userAgent: log.user_agent,
      severity: log.severity,
      createdAt: log.created_at,
    }));

    return NextResponse.json({
      logs,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

