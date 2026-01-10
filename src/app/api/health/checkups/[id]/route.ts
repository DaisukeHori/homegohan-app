import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// 健康診断の詳細取得
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  const { data, error } = await supabase
    .from('health_checkups')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ checkup: data });
}

// 健康診断の更新
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json();

  // 所有権確認
  const { data: existing } = await supabase
    .from('health_checkups')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // 更新
  const { data, error } = await supabase
    .from('health_checkups')
    .update({
      ...body,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ checkup: data });
}

// 健康診断の削除
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  // 所有権確認
  const { data: existing } = await supabase
    .from('health_checkups')
    .select('id, image_url')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // 画像があれば削除
  if (existing.image_url) {
    try {
      const url = new URL(existing.image_url);
      const pathParts = url.pathname.split('/');
      const bucketIndex = pathParts.findIndex(p => p === 'health-checkups');
      if (bucketIndex !== -1) {
        const filePath = pathParts.slice(bucketIndex + 1).join('/');
        await supabase.storage.from('health-checkups').remove([filePath]);
      }
    } catch (err) {
      console.error('Failed to delete image:', err);
      // 画像削除に失敗しても続行
    }
  }

  // レコード削除
  const { error } = await supabase
    .from('health_checkups')
    .delete()
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
