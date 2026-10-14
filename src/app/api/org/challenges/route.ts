import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireOrgAdmin } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { readJsonBody } from '@/lib/http-params';

// 権限: 所属組織の org_role が owner / admin (#1235)。判定は共通の requireOrgAdmin() (#1161)

/**
 * 認可エラー (401 / 403) はそのまま返し、それ以外は 500 の汎用メッセージにする。
 * 生のエラー文は返さず (#1172)、詳細は db-logger (app_logs) にだけ残す。
 */
function handleError(method: string, error: unknown) {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  createLogger(`${method} /api/org/challenges`, generateRequestId()).error('組織チャレンジの処理に失敗しました', error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

// チャレンジ一覧取得
export async function GET(request: Request) {
  try {
    const { profile } = await requireOrgAdmin();
    const supabase = await createClient();

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

  } catch (error) {
    return handleError('GET', error);
  }
}

// チャレンジ作成
export async function POST(request: Request) {
  try {
    const { user, profile } = await requireOrgAdmin();
    const supabase = await createClient();

    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
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
    } = (parsed.body ?? {}) as Record<string, any>;

    if (!title || !challengeType || !startDate || !endDate) {
      return NextResponse.json({ error: 'Required fields missing' }, { status: 400 });
    }

    // #1235: 部署は自組織のものだけ指定できる (他組織の部署 id を付けたチャレンジを作らせない)
    if (departmentId) {
      const { data: department, error: departmentError } = await supabase
        .from('departments')
        .select('id')
        .eq('id', departmentId)
        .eq('organization_id', profile.organization_id)
        .maybeSingle();
      // 22P02: departmentId が uuid の形式でない
      if (departmentError && departmentError.code !== '22P02') throw departmentError;
      if (!department) {
        return NextResponse.json({ error: 'Invalid departmentId' }, { status: 400 });
      }
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

  } catch (error) {
    return handleError('POST', error);
  }
}

// チャレンジ更新
export async function PUT(request: Request) {
  try {
    const { profile } = await requireOrgAdmin();
    const supabase = await createClient();

    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const { id, ...updates } = (parsed.body ?? {}) as Record<string, any>;

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

  } catch (error) {
    return handleError('PUT', error);
  }
}
