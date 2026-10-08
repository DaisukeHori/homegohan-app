/**
 * 健康目標 (health_goals.goal_type) の種類・表示名・単位・値の範囲の単一ソース。
 *
 * goals/page.tsx と health/page.tsx (ダッシュボード) の両方が参照することで、
 * goal_type の英語生値 (例: "steps") がそのまま画面に漏れることを防ぐ。
 * (#1055 UX3-15)
 *
 * #1229: API (POST/PUT /api/health/goals) と AI 相談の set_health_goal / update_health_goal が
 * 目標値を検証するときの「使える種類」と「種類ごとの範囲」もここから引く。
 * DB (health_goals) の検査トリガーは goal_type を列挙にせず形式だけを見る
 * (種類を足すたびに migration を要さないため。supabase/migrations/20261008110100_health_goals_value_trigger.sql)。
 * そのため、使える種類と種類ごとの範囲はアプリ層のこのファイルで決める。
 */
export interface GoalValueRange {
  min: number;
  max: number;
}

export interface GoalTypeDef {
  type: string;
  label: string;
  unit: string;
  /** target_value として受け付ける範囲。min は常に 0 より大きい (DB の検査: target_value > 0) */
  target: GoalValueRange;
  /** current_value として受け付ける範囲。0 は有効な計測値 (例: 今日の歩数 0 歩。DB の検査: current_value >= 0) */
  current: GoalValueRange;
  /** 別名のとき、正式な goal_type (例: step_count → steps)。Web の作成画面と AI には正式名だけを出す */
  aliasOf?: string;
}

// 値の範囲は health_records の同名項目 (src/lib/health-payloads.ts の sanitizeHealthRecordPayload) と揃える:
//   weight 20-300 / body_fat_percentage 1-70 / step_count 0-100000 / sleep_hours 0-24
// 0 以下の目標は意味を持たないので、目標値の下限だけは歩数・睡眠時間でも 0 より大きくする (current との差)。
const STEPS_DEF: GoalTypeDef = {
  type: 'steps',
  label: '1日の歩数',
  unit: '歩',
  target: { min: 1, max: 100000 },
  current: { min: 0, max: 100000 },
};

/** Web の目標作成画面 (goals/page.tsx) に並べる種類。先頭は未知の種類のフォールバック (getGoalTypeDef) にも使う */
export const GOAL_TYPE_DEFS: GoalTypeDef[] = [
  { type: 'weight', label: '体重', unit: 'kg', target: { min: 20, max: 300 }, current: { min: 20, max: 300 } },
  { type: 'body_fat', label: '体脂肪率', unit: '%', target: { min: 1, max: 70 }, current: { min: 1, max: 70 } },
  STEPS_DEF,
];

/**
 * Web の作成画面には出さないが、API が受け付ける種類。
 * 現行のモバイルアプリ (apps/mobile/app/health/goals.tsx) は歩数に step_count、睡眠時間に sleep_hours を送る。
 * 作成済みの目標が使えなくならないよう、モバイルが送る値はそのまま受け付ける。
 */
export const ADDITIONAL_GOAL_TYPE_DEFS: GoalTypeDef[] = [
  { ...STEPS_DEF, type: 'step_count', aliasOf: STEPS_DEF.type },
  { type: 'sleep_hours', label: '睡眠時間', unit: '時間', target: { min: 1, max: 24 }, current: { min: 0, max: 24 } },
];

/** API (Web・モバイル・AI 相談) が受け付ける goal_type の定義すべて */
export const ACCEPTED_GOAL_TYPE_DEFS: GoalTypeDef[] = [...GOAL_TYPE_DEFS, ...ADDITIONAL_GOAL_TYPE_DEFS];

/** API が受け付ける goal_type (別名を含む) */
export const ACCEPTED_GOAL_TYPES: string[] = ACCEPTED_GOAL_TYPE_DEFS.map((def) => def.type);

/** 正式な goal_type (別名を除く)。AI 相談のプロンプトにはこちらだけを出す */
export const CANONICAL_GOAL_TYPES: string[] = ACCEPTED_GOAL_TYPE_DEFS.filter((def) => !def.aliasOf).map(
  (def) => def.type,
);

// goal_type はユーザー入力 (API・AI) から引くため、プロトタイプのキー ('constructor' など) に当たらないよう Map で持つ。
const GOAL_TYPE_MAP: Map<string, GoalTypeDef> = new Map(ACCEPTED_GOAL_TYPE_DEFS.map((def) => [def.type, def]));

/** numeric(10,2) (health_goals の target_value / current_value) に収まる最大値 */
export const HEALTH_GOAL_NUMERIC_MAX = 99999999.99;

/**
 * 種類が分からない goal_type (種類を決める前に作られた既存データなど) に使う範囲。
 * 種類ごとの範囲は決められないが、0 以下の目標値・負の現在値・桁あふれ (numeric(10,2) を超える値) は
 * DB に届く前に止める。target.min の 0.01 は、numeric(10,2) に丸めても 0 にならない最小値。
 */
export const FALLBACK_GOAL_RANGES: { target: GoalValueRange; current: GoalValueRange } = {
  target: { min: 0.01, max: HEALTH_GOAL_NUMERIC_MAX },
  current: { min: 0, max: HEALTH_GOAL_NUMERIC_MAX },
};

/** 受け付ける goal_type の定義を返す。受け付けない種類は undefined */
export function findGoalTypeDef(goalType: string): GoalTypeDef | undefined {
  return GOAL_TYPE_MAP.get(goalType);
}

/** 有限の数値で、範囲 (両端を含む) に収まっているか */
export function isWithinGoalRange(value: unknown, range: GoalValueRange): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= range.min && value <= range.max;
}

/** goal_type から表示ラベルを取得。未知の type は goal_type をそのまま返さず、汎用ラベルにフォールバックする。 */
export function getGoalTypeLabel(goalType: string): string {
  return GOAL_TYPE_MAP.get(goalType)?.label ?? 'その他の目標';
}

export function getGoalTypeDef(goalType: string): GoalTypeDef {
  return GOAL_TYPE_MAP.get(goalType) ?? GOAL_TYPE_DEFS[0];
}

/**
 * AI 相談のプロンプトに載せる、goalType ごとの目標値の範囲 (別名は含めない)。
 * 例: "weight=体重 20〜300kg / body_fat=体脂肪率 1〜70% / steps=1日の歩数 1〜100000歩 / sleep_hours=睡眠時間 1〜24時間"
 */
export function describeGoalRangesForPrompt(): string {
  return ACCEPTED_GOAL_TYPE_DEFS.filter((def) => !def.aliasOf)
    .map((def) => `${def.type}=${def.label} ${def.target.min}〜${def.target.max}${def.unit}`)
    .join(' / ');
}
