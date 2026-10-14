/**
 * 献立生成の究極モード (#1142) の判定 (Next.js 用の入口)
 *
 * 本文 (アクションの引数) の ultimateMode が真偽値の true のときだけ究極モードとして扱う。
 * 数える機能名 (menu_generation_ultimate / menu_generation) と、生成の処理 (Edge Function・キューの行) に渡す値は、
 * どちらもこの判定の結果で決める (数え方と生成が食い違わないように)。
 * 定義は Edge Functions と共用の supabase/functions/_shared/ai-usage-core.ts (Edge Function の直接の呼び出しも同じ判定を使う)。
 * 判定の部品 (src/lib/plan/entitlements.ts) から分けているのは、API ルートのテストが entitlements を差し替えても、
 * この判定は本物のまま動くようにするため。
 */
export { AI_ULTIMATE_MODE_FEATURE, isUltimateModeRequested } from '../../../supabase/functions/_shared/ai-usage-core';
