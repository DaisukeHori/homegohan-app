// src/components/__tests__/NutritionRadarChart.a11y.test.ts
// #1052 (体系的 a11y): 「推移グラフの<svg>にrole/aria-labelが無い」問題への対応として、
// weekly のモーダル群（StatsModal/NutritionDetailModal）が使う NutritionRadarChart に
// role="img" + aria-label（概要）と、スクリーンリーダー向けの sr-only データテーブル
// （全栄養素の詳細代替）を追加した。ホバーでしか出ないツールチップに依存せず、
// キーボード/スクリーンリーダーでも同じ情報に到達できることを検証する。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { NutritionRadarChart } from '../NutritionRadarChart';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // recharts の ResponsiveContainer は ResizeObserver に依存するため jsdom 用にスタブする
  // (このテストの関心事は a11y 属性/データテーブルであり、実際のピクセルサイズ計算ではない)。
  if (typeof (globalThis as any).ResizeObserver === 'undefined') {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('NutritionRadarChart: グラフの a11y (#1052)', () => {
  it('コンテナに role="img" と概要を説明する aria-label が付与される', () => {
    act(() => {
      root.render(
        h(NutritionRadarChart, {
          nutrition: { protein_g: 60, fat_g: 50, carbs_g: 250 },
          selectedNutrients: ['protein_g', 'fat_g', 'carbs_g'],
          size: 180,
          showLabels: true,
        })
      );
    });
    const img = container.querySelector('[role="img"]');
    expect(img, 'role="img" の要素が見つかりません').not.toBeNull();
    const label = img!.getAttribute('aria-label');
    expect(label, 'aria-label が空です').toBeTruthy();
    expect(label).toContain('栄養素レーダーチャート');
    expect(label).toContain('達成率');
  });

  it('recharts の <svg> 本体は aria-hidden な親でラップされ、role="img" の親に集約される（二重読み上げ防止）', () => {
    act(() => {
      root.render(
        h(NutritionRadarChart, {
          nutrition: { protein_g: 60 },
          selectedNutrients: ['protein_g'],
          size: 180,
          showLabels: true,
        })
      );
    });
    const hiddenWrapper = container.querySelector('[aria-hidden="true"]');
    expect(hiddenWrapper, 'aria-hidden ラッパーが見つかりません').not.toBeNull();
  });

  it('スクリーンリーダー向けの sr-only データテーブルに、選択中の全栄養素の行が含まれる', () => {
    act(() => {
      root.render(
        h(NutritionRadarChart, {
          nutrition: { protein_g: 60, fat_g: 50, carbs_g: 250 },
          selectedNutrients: ['protein_g', 'fat_g', 'carbs_g'],
          size: 180,
          showLabels: true,
        })
      );
    });
    const table = container.querySelector('[data-testid="radar-chart-data-table"]') as HTMLTableElement;
    expect(table, 'データテーブルが見つかりません').not.toBeNull();
    expect(table.classList.contains('sr-only'), '視覚上は非表示(sr-only)であるべき').toBe(true);
    const rows = table.querySelectorAll('tbody tr');
    expect(rows.length).toBe(3);
    // 列見出し(栄養素/摂取量/推奨量/達成率)がある
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['栄養素', '摂取量', '推奨量', '達成率']);
  });

  it('ミューテーション感度: aria-label を外すと role="img" 要素に空の aria-label が付く（この属性が実装で意味を持つことの担保）', () => {
    act(() => {
      root.render(
        h(NutritionRadarChart, {
          nutrition: { protein_g: 60 },
          selectedNutrients: ['protein_g'],
          size: 180,
          showLabels: true,
        })
      );
    });
    const img = container.querySelector('[role="img"]');
    // aria-label は動的な文字列(達成率を含む)であり、静的な固定文字列ではないことを確認
    // （実装が displayPercentage を無視した固定文言に後退していないかの回帰検知）
    expect(img!.getAttribute('aria-label')).not.toBe('栄養素レーダーチャート');
  });
});
