import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 家族グループ一覧取得
export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('family_groups')
    .select(`
      id,
      name,
      created_at,
      family_members(id, name, relation)
    `)
    .eq('owner_id', user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const groups = (data || []).map((g: any) => ({
    id: g.id,
    name: g.name,
    memberCount: g.family_members?.length || 0,
    members: g.family_members || [],
    createdAt: g.created_at,
  }));

  return NextResponse.json({ groups });
}

// 家族グループ作成
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();

    // 既存のグループがあるか確認
    const { data: existing } = await supabase
      .from('family_groups')
      .select('id')
      .eq('owner_id', user.id)
      .single();

    if (existing) {
      return NextResponse.json({ error: '既に家族グループが存在します' }, { status: 400 });
    }

    // グループ作成
    const { data: group, error: groupError } = await supabase
      .from('family_groups')
      .insert({
        owner_id: user.id,
        name: body.name || '我が家',
      })
      .select()
      .single();

    if (groupError) throw groupError;

    // 自分をメンバーとして追加
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('nickname, gender, height, weight')
      .eq('id', user.id)
      .single();

    await supabase
      .from('family_members')
      .insert({
        family_group_id: group.id,
        user_id: user.id,
        name: profile?.nickname || 'オーナー',
        relation: 'self',
        gender: profile?.gender,
        height: profile?.height,
        weight: profile?.weight,
        display_order: 0,
      });

    return NextResponse.json({
      success: true,
      group: {
        id: group.id,
        name: group.name,
        createdAt: group.created_at,
      },
    });

  } catch (error: any) {
    console.error('Family group creation error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

