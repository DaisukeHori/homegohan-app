/**
 * POST   /api/org/challenges/[id]/join — 組織チャレンジに参加する (#1132)
 * DELETE /api/org/challenges/[id]/join — 参加をやめる
 *
 * 参加は任意で、本人が自分の意思で選ぶ。対象は、所属組織のいずれかの役割のメンバー (管理者も、一般のメンバーと同じく
 * 参加するかを選ぶ)。判定は共通の requireOrgMember() (src/lib/auth/org-member.ts)。
 *
 * POST の条件 (満たさないときは、参加行を作らない):
 *   - 自分の組織のチャレンジで、開催中 (status = 'active')。下書き・終了・中止は 409 CHALLENGE_NOT_ACTIVE
 *   - 終了日 (JST) を過ぎていない。過ぎていれば 409 CHALLENGE_ENDED (毎日の集計で completed になるまでの間の取りこぼし)
 *   - 食事の記録から計算できる種類 (breakfast_rate / veg_score / cooking_rate)。歩数・体重・カスタムは、
 *     健康データの同意の仕組みができるまで 409 CHALLENGE_TYPE_DISABLED
 *   - 部署を限定したチャレンジは、その部署のメンバーだけ。別の部署は 403 PERM_DEPARTMENT_MISMATCH
 *   - 他組織のチャレンジ・存在しないチャレンジは 404 CHALLENGE_NOT_FOUND (存在を知らせない)
 *   参加行は、本人の権限 (利用者の JWT) で作る。INSERT ポリシー「Users can join challenges」(#1238。#1600 で上の条件を足した:
 *   本人・自分の組織のチャレンジ・進捗 0・順位なし・開催中・使える種類・終了日 (JST) を過ぎていない・部署の限定) が
 *   DB 側でも同じことを確かめる (PostgREST を直接叩いても外せない)。すでに参加していれば、何もせず 200 (alreadyJoined: true)。
 *
 * DELETE: 本人の参加行だけを消す (ポリシー "Users can leave challenges")。参加していなくても 200 (冪等)。
 *   やめた人の記録は、集計にも順位にも残らない。管理者の集計 (延べ数・確定した平均。#1688) は動かない。
 *   チャレンジが終了していても、やめられる。
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/org-member';
import { isUuid } from '@/lib/http-params';
import { CHALLENGE_COLUMNS, challengeError, handleMemberError, type ChallengeRow } from '@/lib/org-challenge-api';
import { isOrgChallengeType, todayJst } from '@/lib/org-challenges';

export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const route = 'POST /api/org/challenges/[id]/join';
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
      .maybeSingle();
    if (error) throw error;

    const challenge = data as unknown as ChallengeRow | null;
    if (!challenge) return notFound();

    if (challenge.department_id && challenge.department_id !== profile.department_id) {
      return challengeError('PERM_DEPARTMENT_MISMATCH', 'このチャレンジは、別の部署の人向けです', 403);
    }
    if (!isOrgChallengeType(challenge.challenge_type)) {
      return challengeError('CHALLENGE_TYPE_DISABLED', 'この種類のチャレンジには参加できません', 409);
    }
    if (challenge.status !== 'active') {
      return challengeError('CHALLENGE_NOT_ACTIVE', '開催中のチャレンジではないため、参加できません', 409);
    }
    // end_date は日付 (YYYY-MM-DD)。JST の今日より前なら終了している
    if (challenge.end_date < todayJst()) {
      return challengeError('CHALLENGE_ENDED', 'このチャレンジは終了しました', 409);
    }

    const { error: insertError } = await supabase
      .from('organization_challenge_participants')
      .insert({ challenge_id: challenge.id, user_id: user.id });
    if (insertError) {
      // 23505: すでに参加している (challenge_id + user_id の一意制約)。何度押しても同じ結果にする
      if (insertError.code === '23505') {
        return NextResponse.json({ joined: true, alreadyJoined: true });
      }
      // 42501: 行レベルセキュリティの拒否 (#1238 / #1600 のポリシー)。上の確認を通ったのに拒否されるのは、所属・部署・状態が途中で変わったとき
      if (insertError.code === '42501') {
        return challengeError('FORBIDDEN', 'このチャレンジに参加する権限がありません', 403);
      }
      throw insertError;
    }

    return NextResponse.json({ joined: true, alreadyJoined: false });
  } catch (error) {
    return handleMemberError(route, error);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const route = 'DELETE /api/org/challenges/[id]/join';
  try {
    const params = await props.params;
    const { user } = await requireOrgMember();

    // uuid でない文字列は、DB に渡すと 22P02 になる。参加していないのと同じ扱い (冪等)
    if (!isUuid(params.id)) return NextResponse.json({ joined: false });

    const supabase = await createClient();
    // 条件の user_id は、認可で確定した本人の ID。ポリシー (本人の行だけ) も同じ条件を DB 側で確かめる
    const { error } = await supabase
      .from('organization_challenge_participants')
      .delete()
      .eq('challenge_id', params.id)
      .eq('user_id', user.id);
    if (error) throw error;

    return NextResponse.json({ joined: false });
  } catch (error) {
    return handleMemberError(route, error);
  }
}
