/**
 * 食事モード設定定数
 *
 * colorKey は各 platform の colors オブジェクトのキーに対応する抽象キー
 * iconKey は各 platform のアイコンマップ (icon-map.ts) で解決する抽象キー
 */

export type ModeKey = 'cook' | 'quick' | 'buy' | 'out' | 'skip' | 'ai_creative';

export interface ModeConfig {
  label: string;
  colorKey: 'success' | 'blue' | 'purple' | 'warning' | 'textMuted' | 'accent';
  bgColorKey: 'successLight' | 'blueLight' | 'purpleLight' | 'warningLight' | 'bg' | 'accentLight';
  iconKey: 'chef-hat' | 'zap' | 'store' | 'utensils-crossed' | 'fast-forward' | 'sparkles';
}

export const MODE_CONFIG: Record<ModeKey, ModeConfig> = {
  cook: {
    label: '自炊',
    colorKey: 'success',
    bgColorKey: 'successLight',
    iconKey: 'chef-hat',
  },
  quick: {
    label: '時短',
    colorKey: 'blue',
    bgColorKey: 'blueLight',
    iconKey: 'zap',
  },
  buy: {
    label: '買う',
    colorKey: 'purple',
    bgColorKey: 'purpleLight',
    iconKey: 'store',
  },
  out: {
    label: '外食',
    colorKey: 'warning',
    bgColorKey: 'warningLight',
    iconKey: 'utensils-crossed',
  },
  skip: {
    label: 'なし',
    colorKey: 'textMuted',
    bgColorKey: 'bg',
    iconKey: 'fast-forward',
  },
  ai_creative: {
    label: 'AI献立',
    colorKey: 'accent',
    bgColorKey: 'accentLight',
    iconKey: 'sparkles',
  },
};
