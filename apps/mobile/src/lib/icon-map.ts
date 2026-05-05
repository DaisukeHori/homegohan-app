/**
 * アイコンマップ (Ionicons)
 *
 * @homegohan/shared の iconKey → Ionicons アイコン名への解決マップ
 */

export const ICON_MAP_IONICONS: Record<string, string> = {
  utensils: 'restaurant',
  leaf: 'leaf',
  soup: 'cafe',
  wheat: 'nutrition',
  salad: 'leaf-outline',
  cake: 'ice-cream',
  help: 'help-circle-outline',
};

export type DishIconKey = keyof typeof ICON_MAP_IONICONS;

/**
 * アイコンマップ (lucide-react-native)
 *
 * @homegohan/shared の iconKey → lucide-react-native コンポーネントへの解決マップ
 * WEB (lucide-react) と完全一致するアイコンを使用
 */
import { Utensils, Leaf, Soup, Wheat, Salad, Cake, HelpCircle } from 'lucide-react-native';
import type React from 'react';

export const ICON_MAP_LUCIDE: Record<string, React.ComponentType<any>> = {
  utensils: Utensils,
  leaf: Leaf,
  soup: Soup,      // cafe (コーヒーカップ) から正しい Soup へ
  wheat: Wheat,    // nutrition から正しい Wheat へ
  salad: Salad,
  cake: Cake,
  help: HelpCircle,
};
