/**
 * 料理役割 (DishRole) 定数と getDishConfig 関数
 *
 * colorKey は各 platform の colors オブジェクトのキーに対応する抽象キー
 * iconKey は各 platform のアイコンマップ (icon-map.ts) で解決する抽象キー
 */

export type DishRole = 'main' | 'side' | 'soup' | 'rice' | 'salad' | 'dessert';

export interface DishConfig {
  label: string;
  colorKey: 'accent' | 'success' | 'blue' | 'warning' | 'purple' | 'textMuted';
  iconKey: 'utensils' | 'leaf' | 'soup' | 'wheat' | 'salad' | 'cake' | 'help';
}

/**
 * 役割に応じた設定を返す（英語・日本語両方対応）
 */
export function getDishConfig(role?: string): DishConfig {
  switch (role) {
    case 'main':
    case '主菜':
    case '主食':
      return { label: '主菜', colorKey: 'accent', iconKey: 'utensils' };
    case 'side':
    case 'side1':
    case 'side2':
    case '副菜':
    case '副食':
      return { label: '副菜', colorKey: 'success', iconKey: 'leaf' };
    case 'soup':
    case '汁物':
    case '味噌汁':
      return { label: '汁物', colorKey: 'blue', iconKey: 'soup' };
    case 'rice':
    case 'ご飯':
    case '白飯':
      return { label: 'ご飯', colorKey: 'warning', iconKey: 'wheat' };
    case 'salad':
    case 'サラダ':
      return { label: 'サラダ', colorKey: 'success', iconKey: 'salad' };
    case 'dessert':
    case 'デザート':
    case 'フルーツ':
      return { label: 'デザート', colorKey: 'purple', iconKey: 'cake' };
    default:
      return { label: role || 'おかず', colorKey: 'textMuted', iconKey: 'help' };
  }
}
