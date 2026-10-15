/**
 * #1665: 食事の区分ごとの見た目の表 (Web と共通のパッケージ) の値を固定する。
 *
 * 各画面が区分との比較の連鎖や手書きの表で持っていた色・下地の色・絵文字・アイコン・表示名を、
 * packages/shared (MEAL_LABELS・MEAL_EMOJIS) と src/lib/meal-type-visuals.ts の表へ移した。
 * 画面の見た目は変えないので、表の値は移す前の各画面の値と同じであることを確かめる。
 * 期待する値は、移す前の画面のソースにあった値を手で書く (表から求めない)。
 * モバイルの表は apps/mobile/__tests__/lib/meal-type-visuals.test.ts が固定する。
 * 表の外に見た目の対応が増えないことは tests/meal-types-no-handwritten-1446.test.ts の #1665 の番兵が見張る。
 */
import { Coffee, Moon, Sun, Utensils } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { MEAL_EMOJIS, MEAL_LABELS, MEAL_ORDER } from '@homegohan/shared';
import {
  MEAL_TYPE_HOME_THEME,
  MEAL_TYPE_RECORD_THEME,
  SERVINGS_MEAL_SHORT_LABELS,
} from '@/lib/meal-type-visuals';

describe('共通の見た目 (packages/shared)', () => {
  it('絵文字は、移す前の『食事を追加』モーダルと『献立を改善』の選択肢の絵文字と同じ', () => {
    expect(MEAL_EMOJIS).toEqual({
      breakfast: '🌅',
      lunch: '☀️',
      dinner: '🌙',
      snack: '🍪',
      midnight_snack: '🌃',
    });
  });

  it('表示名は、移す前の各画面の表 (朝食・昼食・夕食・おやつ・夜食) と同じ', () => {
    expect(MEAL_LABELS).toEqual({
      breakfast: '朝食',
      lunch: '昼食',
      dinner: '夕食',
      snack: 'おやつ',
      midnight_snack: '夜食',
    });
  });

  it('絵文字の表のキーは区分の 5 値と同じ集合', () => {
    expect(Object.keys(MEAL_EMOJIS).sort()).toEqual([...MEAL_ORDER].sort());
  });
});

describe('Web の見た目の表 (src/lib/meal-type-visuals.ts)', () => {
  it('食事を記録する画面の表は、移す前の /meals/new の表 (アイコン・色・下地の色) と同じ', () => {
    expect(MEAL_TYPE_RECORD_THEME).toEqual({
      breakfast: { icon: Coffee, color: '#E5A84B', bg: '#FEF9EE' },
      lunch: { icon: Sun, color: '#E07A5F', bg: '#FDF0ED' },
      dinner: { icon: Moon, color: '#7C6BA0', bg: '#F5F3F8' },
      snack: { icon: Utensils, color: '#6B9B6B', bg: '#EDF5ED' },
      midnight_snack: { icon: Moon, color: '#5B8BC7', bg: '#EEF4FB' },
    });
  });

  it('食事を記録する画面の表の下地の色は、移す前の『食事を追加』モーダルの比較の連鎖の色と同じ', () => {
    // 移す前: breakfast → warningLight / lunch → accentLight / dinner → purpleLight / snack → successLight / それ以外 → blueLight
    expect(MEAL_ORDER.map((mealType) => MEAL_TYPE_RECORD_THEME[mealType].bg)).toEqual([
      '#FEF9EE',
      '#FDF0ED',
      '#F5F3F8',
      '#EDF5ED',
      '#EEF4FB',
    ]);
  });

  it('食事を記録する画面の表の朝・昼・夕の色は、移す前の /meals/[id] の 3 値の表の色と同じ', () => {
    expect(MEAL_TYPE_RECORD_THEME.breakfast.color).toBe('#E5A84B');
    expect(MEAL_TYPE_RECORD_THEME.lunch.color).toBe('#E07A5F');
    expect(MEAL_TYPE_RECORD_THEME.dinner.color).toBe('#7C6BA0');
  });

  it('ホームの表は、移す前のホームの表 (アイコン・色) と同じ', () => {
    expect(MEAL_TYPE_HOME_THEME).toEqual({
      breakfast: { icon: Coffee, color: '#FF9800' },
      lunch: { icon: Sun, color: '#4CAF50' },
      dinner: { icon: Moon, color: '#7C4DFF' },
      snack: { icon: Coffee, color: '#E91E63' },
      midnight_snack: { icon: Moon, color: '#3F51B5' },
    });
  });

  it('人数の表の短い名前は、移す前の人数の設定と買い物の範囲の名前 (朝・昼・夜) と同じ', () => {
    expect(SERVINGS_MEAL_SHORT_LABELS).toEqual({ breakfast: '朝', lunch: '昼', dinner: '夜' });
  });
});
