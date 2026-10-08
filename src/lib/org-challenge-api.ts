// src/lib/org-challenge-api.ts
// 組織チャレンジ (#1132) の API ルートが共通で使う、サーバー側の部品。
//   - チャレンジ行 → 画面に返す形 (DTO) への変換
//   - 管理者向けの集計・参加者向けの順位表を取る DB 関数 (service_role だけが実行できる) の呼び出し
//   - メンバー向けの API のエラー応答 (401 / 403 / 500)
//
// service_role のクライアントは、呼び出し側が認可 (requireOrgMember / requireOrgAdmin) を通したあとに渡す。
// ここの関数は、渡された組織 ID・チャレンジ ID・ユーザー ID だけを対象にする。

import { type SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import {
  RANKING_ENTRY_LIMIT,
  RANKING_OTHER_LABEL,
  RANKING_SELF_LABEL,
  isOrgChallengeType,
  todayJst,
} from '@/lib/org-challenges';

/** organization_challenges から読む列 (どれも実在する列) */
export const CHALLENGE_COLUMNS =
  'id, title, description, challenge_type, target_value, target_unit, start_date, end_date, reward_description, status, department_id';

export interface ChallengeRow {
  id: string;
  title: string;
  description: string | null;
  challenge_type: string;
  target_value: number | string | null;
  target_unit: string | null;
  start_date: string;
  end_date: string;
  reward_description: string | null;
  status: string;
  department_id: string | null;
}

/** numeric は数値で返るが、文字列で来ても壊れないように両方受ける */
export function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * メンバー向けに返すチャレンジの形 (部署 ID など、管理用の項目は含めない)。
 *
 * 状態は、DB の値ではなく見かけの状態にする: 開催中 (active) のままでも、終了日 (JST) を過ぎていれば「終了 (completed)」として返す。
 * DB の状態を終了にするのは毎日 03:10 JST の集計 (update_org_challenge_progress) で、それまでの間 (最大で終了日の翌日の
 * 3 時間ほど。集計が止まっていればもっと長く) に、画面が「開催中」「参加する」を出して、API に 409 で断られるのを防ぐ。
 *
 * @param today JST の今日 (YYYY-MM-DD)。試験用。省略すると今日
 */
export function toMemberChallengeDto(row: ChallengeRow, today: string = todayJst()) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    challengeType: row.challenge_type,
    targetValue: toNumber(row.target_value),
    targetUnit: row.target_unit,
    startDate: row.start_date,
    endDate: row.end_date,
    rewardDescription: row.reward_description,
    status: row.status === 'active' && row.end_date < today ? 'completed' : row.status,
  };
}

/**
 * メンバーに見せてよいチャレンジか。
 * 食事の記録から計算できる種類で、部署を限定したチャレンジは、その部署のメンバーにだけ見せる。
 * (状態 — 開催中・終了 — は、取得する時点で絞る)
 */
export function isVisibleToMember(row: ChallengeRow, member: { department_id: string | null }): boolean {
  if (!isOrgChallengeType(row.challenge_type)) return false;
  return !row.department_id || row.department_id === member.department_id;
}

// ─────────────────────────────────────────────────────────────────────────────
// 集計 (管理者向けの平均・参加者数)
// ─────────────────────────────────────────────────────────────────────────────

export interface ChallengeAggregate {
  /**
   * 今も組織のメンバーである参加者の人数。参加者が最小人数に満たないときは null
   * (少人数だと誰が参加しているかを推測されやすいため。DB の関数が決める)
   */
  participantCount: number | null;
  /** 値を出すのに必要な最小人数 (DB の関数が決める) */
  minParticipants: number;
  /** 集計が済んだ参加者の平均。集計が済んだ人が最小人数に満たないときは null */
  averageValue: number | null;
}

interface AggregateRpcRow {
  challenge_id: string;
  participant_count: number | string | null;
  min_participants: number | string;
  average_value: number | string | null;
}

/**
 * 組織のチャレンジごとの集計を取る (DB の関数 get_org_challenge_aggregates)。人数と平均だけで、個人の値は返らない。
 * 最小人数に満たないチャレンジは、人数や平均が null で返る (DB の関数が決める)。
 *
 * @param admin     service_role のクライアント。認可を通したあとに渡すこと
 * @param organizationId 認可で確認した、呼び出した本人の所属組織
 */
export async function fetchChallengeAggregates(
  admin: Pick<SupabaseClient, 'rpc'>,
  organizationId: string,
): Promise<Map<string, ChallengeAggregate>> {
  const { data, error } = await admin.rpc('get_org_challenge_aggregates', { p_organization_id: organizationId });
  if (error) throw new Error(`get_org_challenge_aggregates に失敗しました: ${error.code ?? ''} ${error.message}`);

  const result = new Map<string, ChallengeAggregate>();
  for (const row of (data ?? []) as AggregateRpcRow[]) {
    result.set(row.challenge_id, {
      participantCount: toNumber(row.participant_count),
      minParticipants: toNumber(row.min_participants) ?? 0,
      averageValue: toNumber(row.average_value),
    });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 順位表 (参加者向け)
// ─────────────────────────────────────────────────────────────────────────────

export interface RankingEntry {
  rank: number;
  value: number;
  isMe: boolean;
  /** 本人は「あなた」。ほかの参加者は、表示名を出す設定のときだけニックネーム、そうでなければ「参加者」 */
  label: string;
}

export interface RankingView {
  entries: RankingEntry[];
  /** 順位がついている参加者の全員の人数 (entries は上位と本人の行だけ) */
  rankedCount: number;
}

interface RankingRpcRow {
  rank: number | string;
  current_value: number | string;
  is_me: boolean;
  nickname: string | null;
  ranked_count: number | string;
}

/**
 * 参加者に見せる順位表を取る (DB の関数 get_org_challenge_ranking)。上位と本人の行だけで、他人の ID は返らない。
 * 呼び出した本人がそのチャレンジの参加者でなければ、DB の関数が 0 行を返す。
 *
 * @param admin     service_role のクライアント。認可を通したあとに渡すこと
 * @param showNames 参加者の表示名を出すか (showParticipantNames())。false のときは、DB からも表示名を取らない
 */
export async function fetchChallengeRanking(
  admin: Pick<SupabaseClient, 'rpc'>,
  params: { challengeId: string; userId: string; showNames: boolean; limit?: number },
): Promise<RankingView> {
  const { data, error } = await admin.rpc('get_org_challenge_ranking', {
    p_challenge_id: params.challengeId,
    p_user_id: params.userId,
    p_limit: params.limit ?? RANKING_ENTRY_LIMIT,
    p_with_names: params.showNames,
  });
  if (error) throw new Error(`get_org_challenge_ranking に失敗しました: ${error.code ?? ''} ${error.message}`);

  const rows = (data ?? []) as RankingRpcRow[];
  const entries = rows.map((row): RankingEntry => {
    const nickname = row.nickname?.trim();
    return {
      rank: toNumber(row.rank) ?? 0,
      value: toNumber(row.current_value) ?? 0,
      isMe: row.is_me === true,
      label: row.is_me ? RANKING_SELF_LABEL : params.showNames && nickname ? nickname : RANKING_OTHER_LABEL,
    };
  });

  return {
    entries,
    rankedCount: rows.length > 0 ? (toNumber(rows[0].ranked_count) ?? rows.length) : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// エラー応答 (メンバー向け API)
// ─────────────────────────────────────────────────────────────────────────────

/** メンバー向け API のエラー本文。画面は error.message をそのまま表示する */
export function challengeError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * 認可エラー (401 / 403) はそのまま返し、それ以外は 500 の汎用メッセージにする。
 * 生のエラー文は返さず (#1172)、詳細は db-logger (app_logs) にだけ残す。
 */
export function handleMemberError(routeName: string, error: unknown) {
  if (error instanceof AuthError) {
    return challengeError('UNAUTHORIZED', 'ログインが必要です', 401);
  }
  if (error instanceof ForbiddenError) {
    return challengeError('FORBIDDEN', error.message, 403);
  }
  createLogger(routeName, generateRequestId()).error('組織チャレンジの処理に失敗しました', error);
  return challengeError('INTERNAL_ERROR', 'Internal server error', 500);
}
