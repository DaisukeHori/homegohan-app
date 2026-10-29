// src/lib/org-challenges.ts
// 組織チャレンジ (#1132) の共通の定義。API (src/app/api/org/**) と画面 (src/app/(main)/challenges, src/app/(org)/org/challenges) で共有する。
//
// #1132 の方針:
//   - 参加は任意。食事の記録から出せる 3 つの指標 (朝食をとれた日の割合・野菜スコア・自炊の割合) で始める
//   - 順位は参加者どうしにだけ見せる。管理者には集計 (人数と平均) だけを見せる
//   - 歩数と体重は、健康データの同意の仕組みを作ってから足す (それまでは作成も参加もできない)
// 指標の計算そのものは DB の関数 update_org_challenge_progress (supabase/migrations/*_org_challenge_progress.sql)。
// ここには「どの種類が使えるか」「画面に出す名前と単位」「順位表に名前を出すかどうか」だけを置く。

import { formatLocalDate } from '@/lib/date-utils';
import { VEG_SCORE_MAX } from '@homegohan/shared';

/** 食事の記録から自動で計算できる種類。DB の関数 update_org_challenge_progress が対象にする challenge_type と同じ */
export const ORG_CHALLENGE_TYPES = ['breakfast_rate', 'veg_score', 'cooking_rate'] as const;

export type OrgChallengeType = (typeof ORG_CHALLENGE_TYPES)[number];

/**
 * 作成も参加もできない種類 (organization_challenges.challenge_type の CHECK 制約には残っている)。
 * steps / weight_loss は、健康データを扱うための同意の仕組みができるまで止める。
 * custom は、値を入れる仕組みが無い (手動で評価する画面が無い) ので止める。
 */
export const DISABLED_ORG_CHALLENGE_TYPES = ['steps', 'weight_loss', 'custom'] as const;

export function isOrgChallengeType(value: unknown): value is OrgChallengeType {
  return typeof value === 'string' && (ORG_CHALLENGE_TYPES as readonly string[]).includes(value);
}

export interface OrgChallengeTypeMeta {
  /** 画面に出す名前 */
  label: string;
  /** 値の単位 (画面の表示用) */
  unit: string;
  /** 何をどう数えるか (参加を決める前に読んでもらう説明) */
  description: string;
  /** 目標値に入れられる範囲 */
  targetMin: number;
  targetMax: number;
  /** 作成フォームの目標値の初期値。null は初期値なし (空欄) */
  defaultTarget: number | null;
}

export const ORG_CHALLENGE_TYPE_META: Record<OrgChallengeType, OrgChallengeTypeMeta> = {
  breakfast_rate: {
    label: '朝食をとれた日の割合',
    unit: '%',
    description:
      'チャレンジの期間のうち、朝食を食べた (食事の記録で完了にした) 日の割合です。1 日に朝食が何回あっても 1 日と数えます。',
    targetMin: 0,
    targetMax: 100,
    defaultTarget: 80,
  },
  veg_score: {
    label: '野菜スコアの平均',
    unit: '点',
    // 野菜スコアは写真の解析が書く 0〜100 点 (VEG_SCORE_MIN / VEG_SCORE_MAX。docs/design/cross/23-planned-meals-score-integrity.md §6.3)。
    // 目標値の上限はその尺度の上限で、初期値は入れない (管理者が入れる)
    description:
      'チャレンジの期間に食べた食事 (完了にしたもの) のうち、野菜スコア (食事の記録に付く野菜の点数) が付いているものの平均です。点数が付いていない食事は数えません。',
    targetMin: 0,
    targetMax: VEG_SCORE_MAX,
    defaultTarget: null,
  },
  cooking_rate: {
    label: '自炊の割合',
    unit: '%',
    description:
      'チャレンジの期間に食べた食事 (完了にしたもの) のうち、自炊 (「自炊」「時短」を選んだ食事) の割合です。',
    targetMin: 0,
    targetMax: 100,
    defaultTarget: 60,
  },
};

/** 種類の名前。使える種類以外 (歩数・体重・カスタム) の名前も、一覧に出すために持っておく */
export const ORG_CHALLENGE_TYPE_LABELS: Record<string, string> = {
  breakfast_rate: ORG_CHALLENGE_TYPE_META.breakfast_rate.label,
  veg_score: ORG_CHALLENGE_TYPE_META.veg_score.label,
  cooking_rate: ORG_CHALLENGE_TYPE_META.cooking_rate.label,
  steps: '歩数',
  weight_loss: '体重減量',
  custom: 'カスタム',
};

/** メンバーに見せるチャレンジの状態 (下書きと中止は見せない) */
export const ORG_CHALLENGE_MEMBER_STATUSES = ['active', 'completed'] as const;

/** チャレンジの状態として DB が受け付ける値 (organization_challenges_status_check) */
export const ORG_CHALLENGE_STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;

export function isOrgChallengeStatus(value: unknown): value is (typeof ORG_CHALLENGE_STATUSES)[number] {
  return typeof value === 'string' && (ORG_CHALLENGE_STATUSES as readonly string[]).includes(value);
}

/**
 * 参加者数・平均を画面に出すのに必要な最小人数 (ORG_CHALLENGE_MIN_PARTICIPANTS) と、参加者数の表示 (formatParticipantCount)。
 * サーバーと Web で同じ値を使うため、置き場は packages/shared/src/org-challenges.ts の 1 つにし、ここからは読み直して出す
 * (モバイルの管理画面も使っていたが、通常の操作で届かない画面として消した。#1598)。
 */
export { ORG_CHALLENGE_MIN_PARTICIPANTS, formatParticipantCount } from '@homegohan/shared';

/** 順位表で、本人以外の参加者に出す名前 (表示名を出さない設定のとき) */
export const RANKING_OTHER_LABEL = '参加者';
/** 順位表で、本人の行に出す名前 */
export const RANKING_SELF_LABEL = 'あなた';

/**
 * 順位表に出す人数の上限 (上位から。本人の行は、圏外でも必ず付ける)。
 * DB の関数 get_org_challenge_ranking の既定の人数 (cfg.default_limit) と同じ値にする (tests/org-challenges-lib.test.ts が確かめる)。
 * DB 側は 1 回に返す人数を cfg.max_limit (100 人) で打ち切るので、それ以下にする。
 */
export const RANKING_ENTRY_LIMIT = 20;

/**
 * 順位表に、参加者の表示名 (ニックネーム) を出すかどうか。
 *
 * 環境変数 ORG_CHALLENGE_SHOW_NAMES が 1 / true / on / yes のときだけ出す。未設定・それ以外は出さない。
 * 参加者どうしに表示名を見せてよいかは、オーナーが社内の方針を確認して決める (#1132 の未決事項)。
 * 決まるまでは出さない (順位と「参加者」「あなた」だけを見せる)。
 * サーバー側だけで読む (API が表示名を載せるかどうかを決める)。NEXT_PUBLIC_ にはしない。
 * Vercel で変えた場合は、再デプロイ後に効く。
 * 値を読むのはこの関数だけ (src/lib/env.ts の一覧の readOnlyBy。tests/env-source-scan.test.ts が確かめる)。
 * 名前を書いて読む (`process.env.ORG_CHALLENGE_SHOW_NAMES`)。process.env をまるごと受け取ると、名前を書かない読み取りになり
 * #1142 の検査 (名前を書かずに process.env を使うのは src/lib/env.ts だけ) に反する。
 *
 * @param value 環境変数の値。省略すると、呼んだ時点の process.env.ORG_CHALLENGE_SHOW_NAMES を読む (テストでは値を直接渡す)
 */
export function showParticipantNames(value: string | undefined = process.env.ORG_CHALLENGE_SHOW_NAMES): boolean {
  const raw = value?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** 日付 (YYYY-MM-DD) の形式と、実在する日かどうかを確かめる */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * 今日の日付 (JST の暦日, YYYY-MM-DD)。DB の update_org_challenge_progress と同じく Asia/Tokyo で決める (#1210 / #1211)。
 * 日付の書式づくりは共通の formatLocalDate (src/lib/date-utils.ts) に任せ、ここでは JST に固定するだけ。
 */
export function todayJst(now: Date = new Date()): string {
  return formatLocalDate(now, 'Asia/Tokyo');
}

/** 値を画面に出す形にする。例: 66.7 -> '66.7%'、100 -> '100%'、3.7 -> '3.7点' (DB が小数第 1 位に丸めた値) */
export function formatOrgChallengeValue(type: string, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const meta = isOrgChallengeType(type) ? ORG_CHALLENGE_TYPE_META[type] : null;
  const unit = meta?.unit ?? '';
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text}${unit}`;
}
