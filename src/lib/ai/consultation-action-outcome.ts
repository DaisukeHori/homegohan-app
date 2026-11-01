/**
 * AI 相談の提案の実行の結果を、チャットに出す一文にする (#2183 Z1)。
 *
 * 判定の本体は @homegohan/shared (packages/shared/src/consultation-action-outcome.ts) に置き、Web の AI 相談
 * (src/components/AIChatBubble.tsx) とモバイルの AI 相談のシート (apps/mobile/src/components/ai/AIAdvisorSheet.tsx) が
 * 同じ関数を使う (#2189 W2)。このファイルは既存の Web の import (@/lib/ai/consultation-action-outcome) のために
 * 同じものを読み直すだけで、判定を持たない。
 */
export {
  AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE,
  consultationActionExecutedMessageOf,
  consultationActionFailureMessageOf,
  consultationActionOutcomeOf,
} from '@homegohan/shared';
export type { ConsultationActionOutcome } from '@homegohan/shared';
