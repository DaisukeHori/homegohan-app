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
