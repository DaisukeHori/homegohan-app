/**
 * StatusBadge コンポーネントのテスト
 * - AI生成 vs 手動 区別バッジ
 * - 各 variant の表示確認
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { StatusBadge } from '../../src/components/ui/StatusBadge';

describe('StatusBadge', () => {
  describe('variant=ai (AI生成バッジ)', () => {
    it('デフォルトラベル "AI" が表示される', () => {
      const { getByText } = render(<StatusBadge variant="ai" />);
      expect(getByText('AI')).toBeTruthy();
    });

    it('カスタムラベルが表示される', () => {
      const { getByText } = render(<StatusBadge variant="ai" label="AI生成" />);
      expect(getByText('AI生成')).toBeTruthy();
    });
  });

  describe('variant=manual (手動バッジ)', () => {
    it('デフォルトラベル "手動" が表示される', () => {
      const { getByText } = render(<StatusBadge variant="manual" />);
      expect(getByText('手動')).toBeTruthy();
    });

    it('カスタムラベルが表示される', () => {
      const { getByText } = render(<StatusBadge variant="manual" label="手動入力" />);
      expect(getByText('手動入力')).toBeTruthy();
    });
  });

  describe('variant=completed', () => {
    it('デフォルトラベル "完了" が表示される', () => {
      const { getByText } = render(<StatusBadge variant="completed" />);
      expect(getByText('完了')).toBeTruthy();
    });
  });

  describe('variant=pending', () => {
    it('デフォルトラベル "未完了" が表示される', () => {
      const { getByText } = render(<StatusBadge variant="pending" />);
      expect(getByText('未完了')).toBeTruthy();
    });
  });

  describe('variant=generating', () => {
    it('デフォルトラベル "生成中" が表示される', () => {
      const { getByText } = render(<StatusBadge variant="generating" />);
      expect(getByText('生成中')).toBeTruthy();
    });
  });

  describe('mode から variant を決定するロジック', () => {
    /**
     * meals/[id].tsx では mode === 'ai_creative' などの判別を
     * StatusBadge の variant に変換する。ここではその変換ロジックを
     * 純粋関数として検証する。
     */
    function modeToVariant(mode: string | null): 'ai' | 'manual' {
      if (!mode) return 'manual';
      return mode === 'ai_creative' ? 'ai' : 'manual';
    }

    it('mode=ai_creative → variant=ai', () => {
      expect(modeToVariant('ai_creative')).toBe('ai');
    });

    it('mode=cook → variant=manual', () => {
      expect(modeToVariant('cook')).toBe('manual');
    });

    it('mode=null → variant=manual', () => {
      expect(modeToVariant(null)).toBe('manual');
    });

    it('mode=quick → variant=manual', () => {
      expect(modeToVariant('quick')).toBe('manual');
    });
  });
});
