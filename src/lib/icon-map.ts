/**
 * アイコンマップ (Lucide React)
 *
 * @homegohan/shared の iconKey → Lucide コンポーネントへの解決マップ
 */

import { Utensils, Leaf, Soup, Wheat, Salad, Cake, HelpCircle } from 'lucide-react';

export const ICON_MAP_LUCIDE = {
  utensils: Utensils,
  leaf: Leaf,
  soup: Soup,
  wheat: Wheat,
  salad: Salad,
  cake: Cake,
  help: HelpCircle,
} as const;

export type DishIconKey = keyof typeof ICON_MAP_LUCIDE;
