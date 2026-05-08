/**
 * 栄養目標プランナー — @homegohan/shared からの再エクスポート。
 *
 * 既存のインポートパス "@/lib/nutrition-target-planner" を維持しつつ、
 * 実装の canonical ソースを packages/shared に一本化する。
 */
export type {
  MacroRatios,
  DerivedMacroTargets,
  GoalProjection,
} from '@homegohan/shared';

export {
  deriveMacroTargets,
  estimateGoalProjection,
} from '@homegohan/shared';
