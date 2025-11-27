import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// サポート統計取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // サポート権限確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', user.id)
    .single();

  if (!profile || !profile?.roles?.some((r: string) => ['admin', 'super_admin', 'support'].includes(r))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // 問い合わせ統計
    const { count: pendingInquiries } = await supabase
      .from('inquiries')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');

    const { count: inProgressInquiries } = await supabase
      .from('inquiries')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'in_progress');

    const { count: resolvedToday } = await supabase
      .from('inquiries')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'resolved')
      .gte('resolved_at', today);

    const { count: totalInquiries } = await supabase
      .from('inquiries')
      .select('*', { count: 'exact', head: true });

    // 問い合わせ種別統計
    const { data: inquiriesByType } = await supabase
      .from('inquiries')
      .select('inquiry_type')
      .eq('status', 'pending');

    const typeCount: Record<string, number> = {};
    (inquiriesByType || []).forEach((i: any) => {
      typeCount[i.inquiry_type] = (typeCount[i.inquiry_type] || 0) + 1;
    });

    // 最近の問い合わせ
    const { data: recentInquiries } = await supabase
      .from('inquiries')
      .select(`
        id,
        inquiry_type,
        subject,
        status,
        created_at,
        user_profiles(nickname)
      `)
      .order('created_at', { ascending: false })
      .limit(10);

    // 自分が対応した件数（今週）
    const { count: myResolved } = await supabase
      .from('admin_audit_logs')
      .select('*', { count: 'exact', head: true })
      .eq('admin_id', user.id)
      .eq('action_type', 'resolve_inquiry')
      .gte('created_at', sevenDaysAgo.toISOString());

    return NextResponse.json({
      overview: {
        pendingInquiries: pendingInquiries || 0,
        inProgressInquiries: inProgressInquiries || 0,
        resolvedToday: resolvedToday || 0,
        totalInquiries: totalInquiries || 0,
        myResolvedThisWeek: myResolved || 0,
      },
      inquiriesByType: typeCount,
      recentInquiries: (recentInquiries || []).map((i: any) => ({
        id: i.id,
        inquiryType: i.inquiry_type,
        subject: i.subject,
        status: i.status,
        createdAt: i.created_at,
        userName: i.user_profiles?.nickname || 'Guest',
      })),
    });

  } catch (error: any) {
    console.error('Support stats error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

