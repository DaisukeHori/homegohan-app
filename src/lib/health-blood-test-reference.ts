/**
 * 血液検査・健診値の基準値 (性別依存) の単一ソースは packages/shared/src/health-blood-test-reference.ts。
 *
 * Web の健診の詳細画面・血液検査の画面と、モバイルの健診の詳細画面 (apps/mobile/app/health/checkups/[id].tsx。#1049。
 * その後 #1598 で消した) が同じ基準値・同じ判定を使うよう、共有パッケージへ移した。Web の既存の import (@/lib/health-blood-test-reference) は
 * このファイルからそのまま読める。
 */
export {
  ALL_METRIC_DEFS,
  BLOOD_METRIC_DEFS,
  BODY_METRIC_DEFS,
  evaluateStatus,
  formatRangeText,
  getMetricLabel,
  getMetricUnit,
  getRangeForSex,
  getStatusLabel,
} from '@homegohan/shared';
export type { BiologicalSex, MetricKey, MetricStatus } from '@homegohan/shared';
