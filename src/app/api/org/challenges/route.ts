import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { ORG_API_INTERNAL_ERROR_MESSAGE, ORG_API_INVALID_JSON_MESSAGE, orgAuthFailureFlat } from '@/lib/org-api-errors';
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
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import {
  ORG_CHALLENGE_LOCK_ERROR_CODES,
  ORG_CHALLENGE_LOCK_HTTP_STATUS,
  isOrgChallengeStatusTransitionAllowed,
  mapChallengeLockError,
} from '@/lib/org-challenge-privacy';

/** 状態・期間の変更を断るときの文 (#1688。CHALLENGE_STATUS_LOCKED / CHALLENGE_PERIOD_LOCKED で同じ文) */
const CHALLENGE_LOCKED_MESSAGE = 'このチャレンジの状態は変えられません';

// 権限: 所属組織の org_role が owner / admin (#1235)。判定は共通の requireOrgAdmin() (#1161)
//
// #1132: 管理者に見せるのは集計 (参加者数と平均) だけ。参加者個人の進み具合・順位は返さない (#1132 の方針)。
//   - 集計は DB の関数 get_org_challenge_aggregates で数える。参加者の行は本人にしか読めない (RLS) ため、認可のあとに service_role で呼ぶ
//   - 最小人数 (DB の関数が決める。10 人。#1600) に満たない間は、値を返さない。少人数だと、誰が参加しているか・誰の値かを推測されやすいため
//       参加した人 (延べ) が最小人数に満たない: participantCount = null
//       終了時点の順位がついた参加者が最小人数に満たない、または終了していない: aggregate.averageValue = null (aggregate.visible = false)
//   - #1688: 参加者数は参加した人の延べ数 (やめても・組織から外れても減らない)。平均は終了時に 1 回だけ確定した値で、
//     同じ種類で期間が重なるチャレンジの中では先に確定した 1 本だけに出す (集計の差分から 1 人の値を逆算させない)
//   - 作成できるのは、食事の記録から計算できる種類 (breakfast_rate / veg_score / cooking_rate) だけ。
//     歩数・体重・カスタムは、健康データの同意の仕組みができるまで作成も開始もできない

/**
 * 認可エラー (401 / 403) はそのまま返し、それ以外は 500 の汎用メッセージにする。
 * 生のエラー文は返さず (#1172)、詳細は db-logger (app_logs) にだけ残す。
 */
function handleError(method: string, error: unknown) {
  // 401 / 403 の文は日本語の固定の文 (src/lib/org-api-errors.ts)。例外の文面は本文に入れない
  const authFailure = orgAuthFailureFlat(error);
  if (authFailure) {
    return authFailure;
  }
  // 500 は汎用の文だけ
  createLogger(`${method} /api/org/challenges`, generateRequestId()).error('組織チャレンジの処理に失敗しました', error);
  return NextResponse.json({ error: ORG_API_INTERNAL_ERROR_MESSAGE }, { status: 500 });
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
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    const { user, profile } = await requireOrgAdmin();
    const supabase = await createClient();

    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      return NextResponse.json({ error: ORG_API_INVALID_JSON_MESSAGE }, { status: 400 });
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
      return NextResponse.json({ error: 'タイトル・種類・開始日・終了日を入力してください' }, { status: 400 });
    }

    // #1132: 作成できるのは、食事の記録から計算できる種類だけ (歩数・体重・カスタムは、同意の仕組みができるまで止める)
    if (!isOrgChallengeType(challengeType)) {
      return NextResponse.json(
        { error: 'この種類のチャレンジは作成できません', code: 'CHALLENGE_TYPE_DISABLED' },
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
        return NextResponse.json({ error: '指定した部署が見つかりません' }, { status: 400 });
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
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    const { profile } = await requireOrgAdmin();
    const supabase = await createClient();

    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      return NextResponse.json({ error: ORG_API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { id, ...updates } = (parsed.body ?? {}) as Record<string, any>;

    if (!id) {
      return NextResponse.json({ error: 'チャレンジの ID を指定してください' }, { status: 400 });
    }
    // uuid でない文字列は、DB に渡すと 22P02 で 500 になる
    if (!isUuid(id)) {
      return NextResponse.json({ error: 'チャレンジの ID の形式が正しくありません' }, { status: 400 });
    }
    if (updates.status !== undefined && !isOrgChallengeStatus(updates.status)) {
      return NextResponse.json({ error: 'チャレンジの状態の値が正しくありません', code: 'INVALID_STATUS' }, { status: 400 });
    }

    // #1688: 状態を変えるときは、現在の行 (状態・種類) を 1 回だけ読み、遷移表 (src/lib/org-challenge-privacy.ts) に無い変更を
    // 409 で断る (終わった状態からは変えない・開催中を下書きに戻さない)。DB のトリガー trg_org_challenge_guard_update (関数 org_challenge_guard_update) も同じ表で止める。
    // 行が無い (他組織・存在しない) ときは、既存どおり更新 0 行で 200
    if (updates.status !== undefined) {
      const { data: current, error: currentError } = await supabase
        .from('organization_challenges')
        .select('status, challenge_type')
        .eq('id', id)
        .eq('organization_id', profile.organization_id)
        .maybeSingle();
      if (currentError) throw currentError;
      const currentRow = current as { status: string | null; challenge_type: string } | null;
      if (
        currentRow &&
        isOrgChallengeStatus(currentRow.status) &&
        !isOrgChallengeStatusTransitionAllowed(currentRow.status, updates.status)
      ) {
        return NextResponse.json(
          { error: CHALLENGE_LOCKED_MESSAGE, code: ORG_CHALLENGE_LOCK_ERROR_CODES.status },
          { status: ORG_CHALLENGE_LOCK_HTTP_STATUS },
        );
      }
      // #1132: 開始 (active) にできるのは、食事の記録から計算できる種類だけ。歩数・体重・カスタムは、同意の仕組みができるまで止める
      if (updates.status === 'active' && currentRow && !isOrgChallengeType(currentRow.challenge_type)) {
        return NextResponse.json(
          { error: 'この種類のチャレンジは開始できません', code: 'CHALLENGE_TYPE_DISABLED' },
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

    if (error) {
      // 読んでから書くまでに状態が変わった場合など、DB のガードの RAISE (P0001 CHALLENGE_STATUS_LOCKED / CHALLENGE_PERIOD_LOCKED) は 409 に写す
      const locked = mapChallengeLockError(error);
      if (locked) {
        return NextResponse.json({ error: CHALLENGE_LOCKED_MESSAGE, code: locked.code }, { status: locked.status });
      }
      throw error;
    }

    return NextResponse.json({ success: true });

  } catch (error) {
    return handleError('PUT', error);
  }
}
