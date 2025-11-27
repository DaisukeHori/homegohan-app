import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// メンバー一覧取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const groupId = searchParams.get('group_id');

  if (!groupId) {
    return NextResponse.json({ error: 'group_id is required' }, { status: 400 });
  }

  // グループ所有者確認
  const { data: group } = await supabase
    .from('family_groups')
    .select('owner_id')
    .eq('id', groupId)
    .single();

  if (!group || group.owner_id !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { data, error } = await supabase
    .from('family_members')
    .select('*')
    .eq('family_group_id', groupId)
    .eq('is_active', true)
    .order('display_order');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const members = (data || []).map((m: any) => ({
    id: m.id,
    name: m.name,
    relation: m.relation,
    birthDate: m.birth_date,
    gender: m.gender,
    height: m.height,
    weight: m.weight,
    allergies: m.allergies || [],
    dislikes: m.dislikes || [],
    dietStyle: m.diet_style,
    healthConditions: m.health_conditions || [],
    favoriteFoods: m.favorite_foods || [],
    spiceTolerance: m.spice_tolerance,
    dailyCalories: m.daily_calories,
    proteinRatio: m.protein_ratio,
    displayOrder: m.display_order,
    userId: m.user_id,
  }));

  return NextResponse.json({ members });
}

// メンバー追加
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();

    if (!body.groupId) {
      return NextResponse.json({ error: 'groupId is required' }, { status: 400 });
    }

    // グループ所有者確認
    const { data: group } = await supabase
      .from('family_groups')
      .select('owner_id')
      .eq('id', body.groupId)
      .single();

    if (!group || group.owner_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // 最大表示順を取得
    const { data: maxOrder } = await supabase
      .from('family_members')
      .select('display_order')
      .eq('family_group_id', body.groupId)
      .order('display_order', { ascending: false })
      .limit(1)
      .single();

    const { data, error } = await supabase
      .from('family_members')
      .insert({
        family_group_id: body.groupId,
        name: body.name,
        relation: body.relation || 'other',
        birth_date: body.birthDate || null,
        gender: body.gender || null,
        height: body.height || null,
        weight: body.weight || null,
        allergies: body.allergies || [],
        dislikes: body.dislikes || [],
        diet_style: body.dietStyle || 'normal',
        health_conditions: body.healthConditions || [],
        favorite_foods: body.favoriteFoods || [],
        spice_tolerance: body.spiceTolerance || 'medium',
        daily_calories: body.dailyCalories || null,
        protein_ratio: body.proteinRatio || null,
        display_order: (maxOrder?.display_order || 0) + 1,
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({
      success: true,
      member: {
        id: data.id,
        name: data.name,
        relation: data.relation,
      },
    });

  } catch (error: any) {
    console.error('Member creation error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

