/**
 * GET /api/org/challenges/[id] — 組織のメンバーが、チャレンジ 1 件の詳細と、自分の進み具合・順位表を見る (#1132)
 *
 * 対象は、所属組織のいずれかの役割のメンバー。判定は共通の requireOrgMember() (src/lib/auth/org-member.ts)。
 * 自分の組織のチャレンジで、メンバーに見せてよいもの (開催中か終了。食事の記録から計算できる種類。
 * 部署を限定したものは、その部署のメンバーだけ) 以外は、存在を知らせないよう 404 にする。
 *
 * 順位表を見られるのは、そのチャレンジの参加者本人だけ (#1132 の方針)。
 *   - 参加していないメンバー (管理者を含む) には、順位表を返さない (ranking.available = false・reason = 'not_joined')
 *   - #1688: 参加していても、組織の管理者 (今の役割が owner / admin。メンバーを組織から外せる人) と、このチャレンジに
 *     「管理者だった印」がある人 (このチャレンジがある間に管理者になったことがある人。member に戻っても残る) には返さない
 *     (ranking.available = false・reason = 'org_admin')。外した人の行が消える前後の順位表を見せないため。自分の記録と順位 (me) は返す。
 *     DB の関数 get_org_challenge_ranking も同じ 2 つの条件で 0 行を返す
 *   - 順位表は、DB の関数 get_org_challenge_ranking が組み立てる。service_role で呼ぶが、
 *     関数の中でも「呼び出した本人が参加者であること」を確かめる。他人の user_id は返らず、本人かどうか (isMe) だけ
 *   - 参加者の表示名は、環境変数 ORG_CHALLENGE_SHOW_NAMES が有効なときだけ出す。
 *     未設定なら、順位と「参加者」「あなた」だけ (参加者どうしに表示名を見せてよいかは、社内の方針の確認待ち)
 *   - 順位表は上位 20 人と本人の行だけ
 */
import { NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/org-member';
import { isUuid } from '@/lib/http-params';
import {
  CHALLENGE_COLUMNS,
  challengeError,
  fetchChallengeAggregates,
  fetchChallengeRanking,
  handleMemberError,
  isVisibleToMember,
  toMemberChallengeDto,
  toNumber,
  type ChallengeRow,
} from '@/lib/org-challenge-api';
import {
  ORG_CHALLENGE_MEMBER_STATUSES,
  ORG_CHALLENGE_MIN_PARTICIPANTS,
  showParticipantNames,
} from '@/lib/org-challenges';
import { canViewChallengeRanking, hasRankingExclusion, type RankingSection } from '@/lib/org-challenge-privacy';

const ROUTE = 'GET /api/org/challenges/[id]';

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const params = await props.params;
    const { user, profile } = await requireOrgMember();

    const notFound = () => challengeError('CHALLENGE_NOT_FOUND', 'チャレンジが見つかりません', 404);
    if (!isUuid(params.id)) return notFound();

    const supabase = await createClient();
    const { data, error } = await supabase
      .from('organization_challenges')
      .select(CHALLENGE_COLUMNS)
      .eq('id', params.id)
      .eq('organization_id', profile.organization_id)
      .in('status', [...ORG_CHALLENGE_MEMBER_STATUSES])
      .maybeSingle();
    if (error) throw error;

    const challenge = data as unknown as ChallengeRow | null;
    if (!challenge || !isVisibleToMember(challenge, profile)) return notFound();

    // 自分の参加行 (参加者の行の SELECT は、本人の行だけ: RLS)
    const { data: participation, error: participationError } = await supabase
      .from('organization_challenge_participants')
      .select('current_value, rank, joined_at')
      .eq('challenge_id', challenge.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (participationError) throw participationError;
    const mine = participation as unknown as {
      current_value: number | string | null;
      rank: number | null;
      joined_at: string | null;
    } | null;

    // 参加者数と順位表は、認可のあとに service_role の DB 関数で取る (自分の組織・このチャレンジだけが対象)。
    // 参加者数は参加した人の延べ数で、最小人数に満たないとき null (管理者向けの API と同じ DB の関数・同じ規則)
    const admin = getSupabaseAdmin();
    const aggregates = await fetchChallengeAggregates(admin, profile.organization_id);
    const aggregate = aggregates.get(challenge.id);
    const showNames = showParticipantNames();

    // 順位表 (#1688 §8.3。上から最初に当たったもの):
    //   1. 参加していない → not_joined (印も順位表の関数も読まない)
    //   2. 今の役割が owner / admin → org_admin (印も順位表の関数も読まない)
    //   3. このチャレンジに管理者だった印がある → org_admin (順位表の関数は呼ばない。印を読めなければ例外で 500)
    //   4. それ以外 → 順位表
    let ranking: RankingSection;
    if (!mine) {
      // showNames は、参加を決める前に「順位表に表示名が出るか」を説明するために返す
      ranking = { available: false, showNames, reason: 'not_joined' };
    } else if (
      !canViewChallengeRanking(profile.org_role) ||
      (await hasRankingExclusion(admin, { challengeId: challenge.id, userId: user.id }))
    ) {
      ranking = { available: false, showNames, reason: 'org_admin' };
    } else {
      const view = await fetchChallengeRanking(admin, { challengeId: challenge.id, userId: user.id, showNames });
      ranking = {
        available: true,
        showNames,
        rankedCount: view.rankedCount,
        // 上位と本人の行だけのとき true (全員は載せていない)
        truncated: view.rankedCount > view.entries.length,
        entries: view.entries,
      };
    }

    return NextResponse.json({
      challenge: toMemberChallengeDto(challenge),
      participantCount: aggregate?.participantCount ?? null,
      minParticipants: aggregate?.minParticipants ?? ORG_CHALLENGE_MIN_PARTICIPANTS,
      joined: mine !== null,
      me: mine
        ? {
            currentValue: toNumber(mine.current_value) ?? 0,
            // 順位は、毎日の集計のあとに入る。参加したばかり (まだ集計されていない) のときは null
            rank: mine.rank,
            joinedAt: mine.joined_at,
          }
        : null,
      ranking,
    });
  } catch (error) {
    return handleMemberError(ROUTE, error);
  }
}
