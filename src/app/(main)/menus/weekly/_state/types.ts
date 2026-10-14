// Refactor B / Issue #1031 Step 0: page.tsx から移設した共有型
// LegacyDishDetail は page.tsx と formDraftStore の両方から参照されるため、
// どちらにも依存しない _state 配下に置く。
import type { DishDetail } from '@/types/domain';

// 旧形式（cal/protein/fat/carbs 等の短縮キー）との後方互換のための型拡張
// dish データが古いスキーマで保存されている可能性があるため
export type LegacyDishDetail = DishDetail & {
  cal?: number;
  protein?: number;
  fat?: number;
  carbs?: number;
  fiber?: number;
  sugar?: number;
  sodium?: number;
  potassium?: number;
  calcium?: number;
  phosphorus?: number;
  iron?: number;
  zinc?: number;
  cholesterol?: number;
  vitaminA?: number;
  vitaminB1?: number;
  vitaminB2?: number;
  vitaminB6?: number;
  vitaminB12?: number;
  vitaminC?: number;
  vitaminD?: number;
  vitaminE?: number;
  vitaminK?: number;
  folicAcid?: number;
};
