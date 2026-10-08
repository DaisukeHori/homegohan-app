import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';

// インサイトを既読にする
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  const { error } = await supabase
    .from('health_insights')
    .update({ is_read: true })
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    return internalError('POST /api/health/insights/[id]/read', error, { userId: user.id, table: 'health_insights' });
  }

  return NextResponse.json({ success: true });
}

