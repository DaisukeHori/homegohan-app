// src/__tests__/app/menus/weekly/progress-todo-card-cancel.test.ts
// Issue #1054 (UX2-11): AI 生成の「中止する」導線に対する回帰防止テスト。
//
// #1054 レビューで判明した問題:
// 1. ProgressTodoCard に onCancel を渡しても、渡さなくても中止ボタンの有無以外は
//    検証されておらず、page.tsx 側の配線 (onCancel={() => setShowConfirmCancelGeneration(true)})
//    を1行消しても落ちるテストが無かった（死コード化に気づけない）。
// 2. ProgressTodoCard 内部に window.confirm が残っており、「window.confirm は使わず
//    styled モーダルに統一する」というコメント/設計と実装が矛盾していた。
//
// このテストは ProgressTodoCard 単体をレンダリングし、
// - onCancel が渡された場合のみ中止ボタンが表示されること
// - 中止ボタンをクリックすると window.confirm を経由せず onCancel が直接呼ばれること
// を検証する。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ProgressTodoCard } from '@/app/(main)/menus/weekly/_components/ProgressTodoCard';

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

const COLORS = { accent: '#5B8266', purple: '#8B5CF6' };
const PROGRESS = { phase: 'generating', message: 'AIが献立を生成中...', percentage: 40 };

function getCancelButton(): HTMLButtonElement | null {
  return container.querySelector('button[aria-label="生成を中止する"]');
}

describe('ProgressTodoCard: 中止ボタン (#1054 UX2-11)', () => {
  it('onCancel が渡された場合のみ、中止ボタンが表示される', () => {
    act(() => {
      root.render(
        h(ProgressTodoCard, { progress: PROGRESS, colors: COLORS, onCancel: () => {} })
      );
    });
    expect(getCancelButton()).not.toBeNull();
  });

  it('onCancel が渡されない場合、中止ボタンは表示されない（従来の buttonless 進捗表示との後方互換）', () => {
    act(() => {
      root.render(h(ProgressTodoCard, { progress: PROGRESS, colors: COLORS }));
    });
    expect(getCancelButton()).toBeNull();
  });

  it('中止ボタンをクリックすると、window.confirm を経由せず onCancel が直接呼ばれる（styled モーダルへの一本化）', () => {
    const onCancel = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    act(() => {
      root.render(h(ProgressTodoCard, { progress: PROGRESS, colors: COLORS, onCancel }));
    });

    const button = getCancelButton();
    expect(button).not.toBeNull();

    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // window.confirm(false) を返しても onCancel は必ず呼ばれる = window.confirm を経由していない証明
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);

    confirmSpy.mockRestore();
  });

  it('エラー状態 (phase: failed) では onCancel が渡されていても中止ボタンを表示しない', () => {
    act(() => {
      root.render(
        h(ProgressTodoCard, {
          progress: { phase: 'failed', message: 'エラーが発生しました', percentage: 0 },
          colors: COLORS,
          onCancel: () => {},
        })
      );
    });
    expect(getCancelButton()).toBeNull();
  });
});
