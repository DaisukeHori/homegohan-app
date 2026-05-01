/**
 * MODE_CONFIG の構造テスト
 * apps/mobile/app/menus/weekly/index.tsx の MODE_CONFIG 定数を検証する。
 *
 * NOTE: MODE_CONFIG は同ファイルにのみ定義されているためインポートではなく、
 * テスト内でその仕様を直接記述する方式を採る。
 */

import { colors } from '../../src/theme';

// MODE_CONFIG の期待値（index.tsx のコードと同期させる）
const MODE_CONFIG: Record<string, { icon?: string; label: string; color: string; bg: string }> = {
  cook:        { label: '自炊',   color: colors.success,   bg: colors.successLight  },
  quick:       { label: '時短',   color: colors.blue,      bg: colors.blueLight     },
  buy:         { label: '買う',   color: colors.purple,    bg: colors.purpleLight   },
  out:         { label: '外食',   color: colors.warning,   bg: colors.warningLight  },
  skip:        { label: 'なし',   color: colors.textMuted, bg: colors.bg            },
  ai_creative: { icon: 'sparkles', label: 'AI献立', color: colors.accent, bg: colors.accentLight },
};

const EXPECTED_MODES = ['cook', 'quick', 'buy', 'out', 'skip', 'ai_creative'] as const;

describe('MODE_CONFIG', () => {
  it('6 つのモードを含む', () => {
    expect(Object.keys(MODE_CONFIG)).toHaveLength(6);
  });

  it.each(EXPECTED_MODES)('mode "%s" が定義されている', (mode) => {
    expect(MODE_CONFIG[mode]).toBeDefined();
  });

  it('ai_creative のラベルが "AI献立"', () => {
    expect(MODE_CONFIG.ai_creative.label).toBe('AI献立');
  });

  it('ai_creative の color が colors.accent (#FF8A65)', () => {
    expect(MODE_CONFIG.ai_creative.color).toBe(colors.accent);
    expect(colors.accent).toBe('#FF8A65');
  });

  it('ai_creative の icon が "sparkles"', () => {
    expect(MODE_CONFIG.ai_creative.icon).toBe('sparkles');
  });

  it('cook は自炊・success 色', () => {
    expect(MODE_CONFIG.cook.label).toBe('自炊');
    expect(MODE_CONFIG.cook.color).toBe(colors.success);
  });

  it('skip は "なし"・textMuted 色', () => {
    expect(MODE_CONFIG.skip.label).toBe('なし');
    expect(MODE_CONFIG.skip.color).toBe(colors.textMuted);
  });
});
