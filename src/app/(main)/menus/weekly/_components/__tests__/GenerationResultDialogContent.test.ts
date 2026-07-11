// src/app/(main)/menus/weekly/_components/__tests__/GenerationResultDialogContent.test.ts
// #1050 round-2 (UX2-02 残課題): 単品再生成・単品AI生成・写真解析・AI画像生成・献立改善の
// 計11箇所で AI 生成失敗が alert() 頼みでリトライ導線が無かった問題への対応として
// UiFlagMessage に onRetry を追加した。このテストは実際に DOM へレンダリングし、
// - onRetry が渡された場合、「もう一度試す」+「閉じる」の2ボタンが表示され、
//   「もう一度試す」クリックで onDismiss → onRetry の順に呼ばれること
// - 「閉じる」クリックでは onDismiss のみ呼ばれ、onRetry は呼ばれないこと
// - onRetry が無い場合は従来どおり単一 OK ボタンのみで、クリックで onDismiss が呼ばれること
// - type: 'error'/'info'/未指定 でアイコンが切り替わること
// を検証する。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { GenerationResultDialogContent } from '../GenerationResultDialogContent';
import { colors } from '../colors';
import type { UiFlagMessage } from '../../_state/reducers/uiFlagReducer';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

function render(message: UiFlagMessage, onDismiss: () => void) {
  act(() => {
    root.render(h(GenerationResultDialogContent, { message, onDismiss }));
  });
}

describe('GenerationResultDialogContent: onRetry 配線 (#1050 round-2 UX2-02残)', () => {
  it('onRetry が渡された場合、「もう一度試す」ボタンのクリックで onDismiss → onRetry の順に呼ばれる', () => {
    const calls: string[] = [];
    const onDismiss = vi.fn(() => calls.push('dismiss'));
    const onRetry = vi.fn(() => calls.push('retry'));
    render(
      { title: '食事の生成に失敗しました', message: 'エラーが発生しました', type: 'error', onRetry },
      onDismiss
    );

    const retryBtn = container.querySelector('[data-testid="success-message-retry-button"]') as HTMLButtonElement;
    expect(retryBtn, '「もう一度試す」ボタンが見つかりません').not.toBeNull();
    expect(container.querySelector('[data-testid="success-message-ok-button"]')).toBeNull();

    act(() => {
      retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    // 表示を確実に消してから retry する順序（表示が残ったまま再実行されない）
    expect(calls).toEqual(['dismiss', 'retry']);
  });

  it('onRetry が渡された場合、「閉じる」ボタンのクリックでは onDismiss のみ呼ばれ、onRetry は呼ばれない', () => {
    const onDismiss = vi.fn();
    const onRetry = vi.fn();
    render(
      { title: '食事の再生成に失敗しました', message: 'エラーが発生しました', type: 'error', onRetry },
      onDismiss
    );

    const closeBtn = container.querySelector('[data-testid="success-message-close-button"]') as HTMLButtonElement;
    expect(closeBtn, '「閉じる」ボタンが見つかりません').not.toBeNull();

    act(() => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('retryLabel を渡すとボタン文言が変わる', () => {
    render(
      { title: '失敗', message: 'エラー', type: 'error', onRetry: () => {}, retryLabel: 'もう一度解析する' },
      () => {}
    );
    const retryBtn = container.querySelector('[data-testid="success-message-retry-button"]');
    expect(retryBtn?.textContent).toBe('もう一度解析する');
  });

  it('onRetry が無い場合は従来どおり単一 OK ボタンのみで、クリックで onDismiss が呼ばれる（既存の成功/情報メッセージとの後方互換）', () => {
    const onDismiss = vi.fn();
    render({ title: '献立が完成しました！', message: 'AIが献立を作成しました。' }, onDismiss);

    expect(container.querySelector('[data-testid="success-message-retry-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="success-message-close-button"]')).toBeNull();

    const okBtn = container.querySelector('[data-testid="success-message-ok-button"]') as HTMLButtonElement;
    expect(okBtn, 'OK ボタンが見つかりません').not.toBeNull();
    expect(okBtn.textContent).toBe('OK');

    act(() => {
      okBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('type: "error" で AlertTriangle アイコンが表示される', () => {
    render({ title: 'エラー', message: '失敗しました', type: 'error' }, () => {});
    const icon = container.querySelector('[data-testid="success-message-icon"]');
    expect(icon?.querySelector('svg')).not.toBeNull();
    // AlertTriangle は danger 色で描画される（backgroundにdangerLightが使われる）
    expect((icon as HTMLElement).style.background).not.toBe('');
  });

  it('タイトル・本文がそのまま表示される', () => {
    render({ title: 'タイトルA', message: '本文B', type: 'info' }, () => {});
    expect(container.querySelector('[data-testid="success-message-title"]')?.textContent).toBe('タイトルA');
    expect(container.querySelector('[data-testid="success-message-body"]')?.textContent).toBe('本文B');
  });
});

describe('GenerationResultDialogContent: 配色は weekly page.tsx の正本と一致する (#1050 レビュー残ポリッシュ, 視覚回帰是正)', () => {
  // Opus 再レビューの Warning: 以前はこのコンポーネントが独自に colors を再定義しており、
  // page.tsx の正本 (success #6B9B6B / successLight #EDF5ED / border #E8E8E8) と乖離していた
  // （旧値: success #4CAF50 / successLight rgba(34,197,94,0.1) / border #E8E6E1）。
  // ./colors.ts を単一の正本にしたため、page.tsx の実値をハードコードして直接照合する。
  const PAGE_CANONICAL = {
    success: '#6B9B6B',
    successLight: '#EDF5ED',
    border: '#E8E8E8',
  };

  it('正本 colors モジュールの success/successLight/border が page.tsx の実値と一致する（二重定義の再発防止）', () => {
    expect(colors.success).toBe(PAGE_CANONICAL.success);
    expect(colors.successLight).toBe(PAGE_CANONICAL.successLight);
    expect(colors.border).toBe(PAGE_CANONICAL.border);
  });

  it('成功メッセージ(type未指定)のアイコン背景・Checkアイコン色が正本の success 系カラーになる', () => {
    render({ title: '献立が完成しました！', message: 'AIが献立を作成しました。' }, () => {});
    const icon = container.querySelector('[data-testid="success-message-icon"]') as HTMLElement;
    expect(icon.style.background).toBe(hexToRgb(PAGE_CANONICAL.successLight));
    const svgPath = icon.querySelector('svg');
    expect(svgPath?.getAttribute('color') ?? svgPath?.getAttribute('stroke')).toBe(PAGE_CANONICAL.success);
  });

  it('onRetry ありの「閉じる」ボタン背景が正本の border カラーになる', () => {
    render({ title: '失敗', message: 'エラー', type: 'error', onRetry: () => {} }, () => {});
    const closeBtn = container.querySelector('[data-testid="success-message-close-button"]') as HTMLElement;
    expect(closeBtn.style.background).toBe(hexToRgb(PAGE_CANONICAL.border));
  });
});

// jsdom は style.background に hex を設定すると rgb(...) 表記で正規化するため、
// テストの期待値も同じ正規化を通してから比較する。
function hexToRgb(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const [, r, g, b] = m;
  return `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`;
}
