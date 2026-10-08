/**
 * GET /api/org/my-challenges — 組織のメンバーが、自分の組織のチャレンジと自分の参加状況を見る (#1132)
 *
 * 対象は、所属組織のいずれかの役割のメンバー。判定は共通の requireOrgMember() (src/lib/auth/org-member.ts)。
 * 管理者にも同じものを返す (管理者が見るのは、一般のメンバーと同じ「参加するか選べるチャレンジ」)。
 * 管理者向けの集計は GET /api/org/challenges (requireOrgAdmin) で、参加者個人の値は誰にも返さない。
 *
 * 返すもの:
 *   - 食事の記録から計算できる種類 (breakfast_rate / veg_score / cooking_rate) で、開催中か終了したチャレンジ
 *     (下書き・中止・歩数/体重/カスタムは出さない)。部署を限定したチャレンジは、その部署のメンバーにだけ
 *   - チャレンジごとの参加者数 (人数だけ。参加者が最小人数に満たないときは null: 少人数だと誰が参加しているかを推測されやすいため。
 *     管理者もメンバーとしてこの API を呼べるので、管理者向けの API と同じ DB の関数で、同じ規則で人数を出す)
 *   - 自分の参加状況と、自分の進み具合・順位 (自分の行だけ。順位がまだ無ければ rank は null)
 * 他の参加者の値・順位は返さない (順位表は GET /api/org/challenges/[id] で、参加者本人にだけ返す)。
 */
import { NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/org-member';
import {
  CHALLENGE_COLUMNS,
  fetchChallengeAggregates,
  handleMemberError,
  isVisibleToMember,
  toMemberChallengeDto,
  toNumber,
  type ChallengeAggregate,
  type ChallengeRow,
} from '@/lib/org-challenge-api';
import {
  ORG_CHALLENGE_MEMBER_STATUSES,
  ORG_CHALLENGE_MIN_PARTICIPANTS,
  ORG_CHALLENGE_TYPES,
} from '@/lib/org-challenges';

const ROUTE = 'GET /api/org/my-challenges';

interface MyParticipationRow {
  challenge_id: string;
  current_value: number | string | null;
  rank: number | null;
  joined_at: string | null;
}

export async function GET() {
  try {
    const { user, profile } = await requireOrgMember();
    const supabase = createClient();

    const { data: rows, error } = await supabase
      .from('organization_challenges')
      .select(CHALLENGE_COLUMNS)
      .eq('organization_id', profile.organization_id)
      .in('status', [...ORG_CHALLENGE_MEMBER_STATUSES])
      .in('challenge_type', [...ORG_CHALLENGE_TYPES])
      .order('start_date', { ascending: false });
    if (error) throw error;

    const challenges = ((rows ?? []) as unknown as ChallengeRow[]).filter((row) => isVisibleToMember(row, profile));

    // 自分の参加行 (参加者の行の SELECT は、本人の行だけ: RLS)
    const mine = new Map<string, MyParticipationRow>();
    if (challenges.length > 0) {
      const { data: participation, error: participationError } = await supabase
        .from('organization_challenge_participants')
        .select('challenge_id, current_value, rank, joined_at')
        .eq('user_id', user.id)
        .in(
          'challenge_id',
          challenges.map((c) => c.id),
        );
      if (participationError) throw participationError;
      for (const row of (participation ?? []) as unknown as MyParticipationRow[]) {
        mine.set(row.challenge_id, row);
      }
    }

    // 参加者数。他人の行は読まず、DB の関数が数えた人数だけを受け取る (認可のあとに、自分の組織だけを対象にする)。
    // 参加者が最小人数に満たないときは、DB の関数が null にして返す
    const aggregates = challenges.length > 0
      ? await fetchChallengeAggregates(getSupabaseAdmin(), profile.organization_id)
      : new Map<string, ChallengeAggregate>();
    const minParticipants = [...aggregates.values()][0]?.minParticipants ?? ORG_CHALLENGE_MIN_PARTICIPANTS;

    const items = challenges.map((row) => {
      const participation = mine.get(row.id);
      return {
        ...toMemberChallengeDto(row),
        participantCount: aggregates.get(row.id)?.participantCount ?? null,
        joined: participation !== undefined,
        me: participation
          ? {
              currentValue: toNumber(participation.current_value) ?? 0,
              // 順位は、毎日の集計のあとに入る。参加したばかり (まだ集計されていない) のときは null
              rank: participation.rank,
              joinedAt: participation.joined_at,
            }
          : null,
      };
    });

    // 開催中を先に。同じ状態の中では、開始日が新しい順 (取得時の順を保つ)
    const statusOrder = (status: string) => (status === 'active' ? 0 : 1);
    items.sort((a, b) => statusOrder(a.status) - statusOrder(b.status));

    return NextResponse.json({ challenges: items, minParticipants });
  } catch (error) {
    return handleMemberError(ROUTE, error);
  }
}
