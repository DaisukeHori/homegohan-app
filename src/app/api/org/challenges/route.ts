import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireOrgAdmin } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { isUuid, readJsonBody } from '@/lib/http-params';
import { fetchChallengeAggregates } from '@/lib/org-challenge-api';
import {
  ORG_CHALLENGE_MIN_PARTICIPANTS,
  ORG_CHALLENGE_TYPE_META,
  isIsoDate,
  isOrgChallengeStatus,
  isOrgChallengeType,
} from '@/lib/org-challenges';

// 権限: 所属組織の org_role が owner / admin (#1235)。判定は共通の requireOrgAdmin() (#1161)
//
// #1132: 管理者に見せるのは集計 (参加者数と平均) だけ。参加者個人の進み具合・順位は返さない (オーナー判断 2026-10-08)。
//   - 集計は DB の関数 get_org_challenge_aggregates で数える。参加者の行は本人にしか読めない (RLS) ため、認可のあとに service_role で呼ぶ
//   - 最小人数 (DB の関数が決める。5 人) に満たない間は、値を返さない。少人数だと、誰が参加しているか・誰の値かを推測されやすいため
//       参加者が最小人数に満たない: participantCount = null
//       集計が済んだ参加者が最小人数に満たない: aggregate.averageValue = null (aggregate.visible = false)
//   - 作成できるのは、食事の記録から計算できる種類 (breakfast_rate / veg_score / cooking_rate) だけ。
//     歩数・体重・カスタムは、健康データの同意の仕組みができるまで作成も開始もできない

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

    // 参加者数と平均。参加者の行は本人にしか読めない (RLS) ので、認可のあとに service_role で DB の関数を呼ぶ。
    // 返るのは人数と平均だけ (個人の値は返らない)。対象は、確認済みのプロフィールの所属組織だけ。
    // 最小人数に満たないときの人数・平均は、DB の関数が null にして返す
    const aggregates = await fetchChallengeAggregates(getSupabaseAdmin(), profile.organization_id);

    const challengesWithParticipants = (challenges || []).map((c: any) => {
      const aggregate = aggregates.get(c.id);
      // 平均を出せるのは、食事の記録から計算できる種類だけ
      const averageValue = isOrgChallengeType(c.challenge_type) ? (aggregate?.averageValue ?? null) : null;
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
        // 参加者が最小人数に満たないときは null (「最小人数未満」と表示する)
        participantCount: aggregate?.participantCount ?? null,
        aggregate: {
          // 人数と平均を出すのに必要な、参加者の最小人数
          minParticipants: aggregate?.minParticipants ?? ORG_CHALLENGE_MIN_PARTICIPANTS,
          // false のとき averageValue は null (少人数の平均から、個人が分かってしまわないようにする)
          visible: averageValue !== null,
          averageValue,
        },
        createdAt: c.created_at,
      };
    });

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

    // #1132: 作成できるのは、食事の記録から計算できる種類だけ (歩数・体重・カスタムは、同意の仕組みができるまで止める)
    if (!isOrgChallengeType(challengeType)) {
      return NextResponse.json(
        { error: 'この種類のチャレンジは、まだ作成できません', code: 'CHALLENGE_TYPE_DISABLED' },
        { status: 400 },
      );
    }
    if (typeof title !== 'string' || !isIsoDate(startDate) || !isIsoDate(endDate) || startDate > endDate) {
      return NextResponse.json(
        { error: '開始日と終了日は YYYY-MM-DD の形式で、開始日が終了日以前になるよう指定してください', code: 'INVALID_PERIOD' },
        { status: 400 },
      );
    }
    if (targetValue !== undefined && targetValue !== null) {
      const meta = ORG_CHALLENGE_TYPE_META[challengeType];
      if (typeof targetValue !== 'number' || !Number.isFinite(targetValue) || targetValue < meta.targetMin || targetValue > meta.targetMax) {
        return NextResponse.json(
          { error: `目標値は ${meta.targetMin} 以上 ${meta.targetMax} 以下で指定してください`, code: 'INVALID_TARGET' },
          { status: 400 },
        );
      }
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
    // uuid でない文字列は、DB に渡すと 22P02 で 500 になる
    if (!isUuid(id)) {
      return NextResponse.json({ error: 'Invalid challenge ID' }, { status: 400 });
    }
    if (updates.status !== undefined && !isOrgChallengeStatus(updates.status)) {
      return NextResponse.json({ error: 'Invalid status', code: 'INVALID_STATUS' }, { status: 400 });
    }

    // #1132: 開始 (active) にできるのは、食事の記録から計算できる種類だけ。歩数・体重・カスタムは、同意の仕組みができるまで止める
    if (updates.status === 'active') {
      const { data: current, error: currentError } = await supabase
        .from('organization_challenges')
        .select('challenge_type')
        .eq('id', id)
        .eq('organization_id', profile.organization_id)
        .maybeSingle();
      if (currentError) throw currentError;
      if (current && !isOrgChallengeType((current as { challenge_type: string }).challenge_type)) {
        return NextResponse.json(
          { error: 'この種類のチャレンジは、まだ開始できません', code: 'CHALLENGE_TYPE_DISABLED' },
          { status: 400 },
        );
      }
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
