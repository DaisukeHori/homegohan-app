import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// AI分析結果の取得
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '20');
  const unreadOnly = searchParams.get('unread') === 'true';
  const alertsOnly = searchParams.get('alerts') === 'true';

  let query = supabase
    .from('health_insights')
    .select('*')
    .eq('user_id', user.id)
    .eq('is_dismissed', false)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (unreadOnly) {
    query = query.eq('is_read', false);
  }
  if (alertsOnly) {
    query = query.eq('is_alert', true);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 未読数もカウント
  const { count: unreadCount } = await supabase
    .from('health_insights')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('is_read', false)
    .eq('is_dismissed', false);

  // アラート数もカウント
  const { count: alertCount } = await supabase
    .from('health_insights')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('is_alert', true)
    .eq('is_dismissed', false);

  return NextResponse.json({ 
    insights: data,
    unreadCount: unreadCount || 0,
    alertCount: alertCount || 0,
  });
}

