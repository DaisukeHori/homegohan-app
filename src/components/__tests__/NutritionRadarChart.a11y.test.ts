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

describe('NutritionRadarChart: 構造回帰テスト (#1052 敵対レビュー統合修正)', () => {
  // Opus 指摘: role="img" は WAI-ARIA 上、子孫をアクセシビリティツリーから剪定する。
  // sr-only データテーブルと過剰摂取アラート(role="alert")が role="img" の子孫のままだと
  // 支援技術に一切露出しない（せっかくの a11y 対応が非機能化し、既存の alert も回帰する）。
  // そのため両者は role="img" の「兄弟」に置く構造でなければならない。
  // この一群のテストは「1行戻す」= table/alert を role="img" の内側に戻すと落ちる。

  it('sr-only データテーブルは role="img" の子孫ではない（兄弟）', () => {
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
    const table = container.querySelector('[data-testid="radar-chart-data-table"]');
    expect(table, 'データテーブルが見つかりません').not.toBeNull();
    expect(
      table!.closest('[role="img"]'),
      'sr-only テーブルが role="img" の子孫になっている（支援技術から読み上げ不能）'
    ).toBeNull();
  });

  it('過剰摂取アラート(role="alert")は role="img" の子孫ではない（兄弟）', () => {
    act(() => {
      root.render(
        h(NutritionRadarChart, {
          // fullValue が OVERCONSUMPTION_THRESHOLD(150%) を超えるよう大きな値を渡す
          // (キーは NUTRIENT_DEFINITIONS に実在する 'proteinG' を使う。DRI=60g に対し
          // 600g は 1000% となり閾値 150% を大きく超える)
          nutrition: { proteinG: 600 },
          selectedNutrients: ['proteinG'],
          size: 180,
          showLabels: true,
        })
      );
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert, '過剰摂取アラートが見つかりません（テストの前提条件を確認）').not.toBeNull();
    expect(
      alert!.closest('[role="img"]'),
      'role="alert" が role="img" の子孫になっている（支援技術から読み上げ不能）'
    ).toBeNull();
  });

  it('role="img" ラッパーはチャート本体（recharts の SVG）だけを包み、幅/高さ100%を持つ', () => {
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
    const img = container.querySelector('[role="img"]') as HTMLElement;
    expect(img).not.toBeNull();
    // 0高さ回帰の直接的な原因は、中間ラッパーが height:auto になり
    // ResponsiveContainer(height:100%) が 0 に解決してしまうことだった。
    // w-full/h-full (width/height:100%) をラッパーが継承していることを構造的に担保する。
    expect(img.className).toContain('w-full');
    expect(img.className).toContain('h-full');
    // テーブルやアラートを飲み込んでいない（子孫に table や alert がない）
    expect(img.querySelector('[data-testid="radar-chart-data-table"]')).toBeNull();
    expect(img.querySelector('[role="alert"]')).toBeNull();
  });

  it('role="img" の子（ResponsiveContainer の直接の親である aria-hidden 中間ラッパー）も幅/高さ100%を持つ', () => {
    // このラッパーの h-full が外れると ResponsiveContainer(height="100%") の基準となる
    // 高さが height:auto に解決してしまい、0高さ回帰（チャートが描画されない）を招く。
    // role="img" 自体だけでなく、その内側の aria-hidden ラッパーにも w-full/h-full が
    // 必要であることを構造的に担保する（実測ミューテーション: この assert を追加した上で
    // 実装側の aria-hidden ラッパーから h-full を外すと本テストが red になることを確認済み）。
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
    const img = container.querySelector('[role="img"]') as HTMLElement;
    const hiddenWrapper = img.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(hiddenWrapper, 'aria-hidden 中間ラッパーが見つかりません').not.toBeNull();
    expect(hiddenWrapper.className).toContain('w-full');
    expect(hiddenWrapper.className).toContain('h-full');
  });

  it('外側コンテナは固定サイズ(width/height=size)を持ち、role="img" はその内側にある', () => {
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
    const img = container.querySelector('[role="img"]') as HTMLElement;
    const outer = img.parentElement as HTMLElement;
    expect(outer.style.width).toBe('180px');
    expect(outer.style.height).toBe('180px');
  });

  it('onTap 指定時、外側コンテナはキーボードで活性化できる（role="button"+tabIndex=0+Enter/Space）', () => {
    const onTap = vi.fn();
    act(() => {
      root.render(
        h(NutritionRadarChart, {
          nutrition: { protein_g: 60 },
          selectedNutrients: ['protein_g'],
          size: 180,
          showLabels: true,
          onTap,
        })
      );
    });
    // role="img" と role="button" が別要素であること（role="img" は外側コンテナに付いていない）
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.getAttribute('role')).toBe('button');
    expect(outer.getAttribute('tabindex')).toBe('0');

    act(() => {
      outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onTap).toHaveBeenCalledTimes(1);

    act(() => {
      outer.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    });
    expect(onTap).toHaveBeenCalledTimes(2);
  });

  it('#1052 レビュー残指摘: onTap 指定時、外側 role="button" コンテナに明示的な aria-label が付与される（sr-only テーブルのボタン名への平坦化を防止）', () => {
    act(() => {
      root.render(
        h(NutritionRadarChart, {
          nutrition: { protein_g: 60 },
          selectedNutrients: ['protein_g'],
          size: 140,
          showLabels: false,
          onTap: vi.fn(),
        })
      );
    });
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.getAttribute('role')).toBe('button');
    const label = outer.getAttribute('aria-label');
    expect(label, 'role="button" コンテナに aria-label がありません').toBeTruthy();
    expect(label).toContain('達成率');
    expect(label).toContain('タップで詳細');
  });

  it('#1052 レビュー残指摘: sr-only データテーブルは role="button" コンテナの子孫ではない（mini radar 用途でも平坦化・剪定されない）', () => {
    act(() => {
      root.render(
        h(NutritionRadarChart, {
          nutrition: { protein_g: 60, fat_g: 50, carbs_g: 250 },
          selectedNutrients: ['protein_g', 'fat_g', 'carbs_g'],
          size: 140,
          showLabels: false,
          onTap: vi.fn(),
        })
      );
    });
    const table = container.querySelector('[data-testid="radar-chart-data-table"]');
    expect(table, 'データテーブルが見つかりません').not.toBeNull();
    expect(
      table!.closest('[role="button"]'),
      'sr-only テーブルが role="button" の子孫になっている（button 名への平坦化 or 剪定リスク）'
    ).toBeNull();
  });

  it('onTap 未指定時は外側コンテナに role="button" が付かない（クリック不可な箇所を誤ってキーボードフォーカス可能にしない）', () => {
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
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.getAttribute('role')).toBeNull();
    expect(outer.getAttribute('tabindex')).toBeNull();
  });
});
