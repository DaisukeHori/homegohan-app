/**
 * 健康目標 (health_goals.goal_type) の表示名・単位の単一ソース。
 *
 * goals/page.tsx と health/page.tsx (ダッシュボード) の両方が参照することで、
 * goal_type の英語生値 (例: "steps") がそのまま画面に漏れることを防ぐ。
 * (#1055 UX3-15)
 */
export interface GoalTypeDef {
  type: string;
  label: string;
  unit: string;
}

export const GOAL_TYPE_DEFS: GoalTypeDef[] = [
  { type: 'weight', label: '体重', unit: 'kg' },
  { type: 'body_fat', label: '体脂肪率', unit: '%' },
  { type: 'steps', label: '1日の歩数', unit: '歩' },
];

const GOAL_TYPE_MAP: Record<string, GoalTypeDef> = Object.fromEntries(
  GOAL_TYPE_DEFS.map((def) => [def.type, def]),
);

/** goal_type から表示ラベルを取得。未知の type は goal_type をそのまま返さず、汎用ラベルにフォールバックする。 */
export function getGoalTypeLabel(goalType: string): string {
  return GOAL_TYPE_MAP[goalType]?.label ?? 'その他の目標';
}

export function getGoalTypeDef(goalType: string): GoalTypeDef {
  return GOAL_TYPE_MAP[goalType] ?? GOAL_TYPE_DEFS[0];
}
