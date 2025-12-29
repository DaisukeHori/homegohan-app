import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// チャレンジ一覧取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, roles')
    .eq('id', user.id)
    .single();

  if (!profile?.roles?.includes('org_admin') || !profile?.organization_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');

    let query = supabase
      .from('organization_challenges')
      .select(`
        id,
        title,
        description,
        challenge_type,
        target_value,
        target_unit,
        start_date,
        end_date,
        reward_description,
        status,
        department_id,
        created_at,
        departments(name)
      `)
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data: challenges, error } = await query;
    if (error) throw error;

    // 参加者数を取得
    const challengesWithParticipants = await Promise.all(
      (challenges || []).map(async (c: any) => {
        const { count } = await supabase
          .from('organization_challenge_participants')
          .select('*', { count: 'exact', head: true })
          .eq('challenge_id', c.id);

        return {
          id: c.id,
          title: c.title,
          description: c.description,
          challengeType: c.challenge_type,
          targetValue: c.target_value,
          targetUnit: c.target_unit,
          startDate: c.start_date,
          endDate: c.end_date,
          rewardDescription: c.reward_description,
          status: c.status,
          departmentId: c.department_id,
          departmentName: c.departments?.name || null,
          participantCount: count || 0,
          createdAt: c.created_at,
        };
      })
    );

    return NextResponse.json({ challenges: challengesWithParticipants });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// チャレンジ作成
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, roles')
    .eq('id', user.id)
    .single();

  if (!profile?.roles?.includes('org_admin') || !profile?.organization_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const {
      title,
      description,
      challengeType,
      targetValue,
      targetUnit,
      startDate,
      endDate,
      rewardDescription,
      departmentId,
    } = body;

    if (!title || !challengeType || !startDate || !endDate) {
      return NextResponse.json({ error: 'Required fields missing' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('organization_challenges')
      .insert({
        organization_id: profile.organization_id,
        title,
        description,
        challenge_type: challengeType,
        target_value: targetValue,
        target_unit: targetUnit,
        start_date: startDate,
        end_date: endDate,
        reward_description: rewardDescription,
        department_id: departmentId || null,
        status: 'draft',
        created_by: user.id,
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({
      success: true,
      challenge: {
        id: data.id,
        title: data.title,
        status: data.status,
      },
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// チャレンジ更新
export async function PUT(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, roles')
    .eq('id', user.id)
    .single();

  if (!profile?.roles?.includes('org_admin') || !profile?.organization_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: 'Challenge ID is required' }, { status: 400 });
    }

    const updateData: any = {};
    if (updates.title !== undefined) updateData.title = updates.title;
    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.targetValue !== undefined) updateData.target_value = updates.targetValue;
    if (updates.targetUnit !== undefined) updateData.target_unit = updates.targetUnit;
    if (updates.rewardDescription !== undefined) updateData.reward_description = updates.rewardDescription;
    if (updates.status !== undefined) updateData.status = updates.status;

    const { error } = await supabase
      .from('organization_challenges')
      .update(updateData)
      .eq('id', id)
      .eq('organization_id', profile.organization_id);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

