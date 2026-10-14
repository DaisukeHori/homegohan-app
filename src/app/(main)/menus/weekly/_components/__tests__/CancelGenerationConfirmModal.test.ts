// src/app/(main)/menus/weekly/_components/__tests__/CancelGenerationConfirmModal.test.ts
// #1050 round-2: AI生成の中止確認モーダル (<CancelGenerationConfirmModal />) の
// behavioral（実レンダリング）回帰防止テスト。
//
// このコンポーネントは「activeModal を一切 props に取らない」設計そのものが
// #1050 round-2 Critical バグ（活動中モーダルが null になると中止確認モーダルごと
// 描画されなくなる）の再発防止策になっている。ここでは実際に DOM へレンダリングし、
// show=true で常にダイアログへ到達できること、ボタン操作が正しいハンドラに
// 配線されていることを検証する（page.tsx 内での配置・呼び出し位置の検証は
// cancel-generation-modal-reachability.test.ts の AST ベーステストが担当する）。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { CancelGenerationConfirmModal } from '../CancelGenerationConfirmModal';

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
  document.body.style.overflow = '';
});

function getDialog(): Element | null {
  return container.querySelector('[role="dialog"]');
}

function findButtonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text)
  );
}

describe('CancelGenerationConfirmModal: 到達可能性・behavioral (#1050 round-2 Critical)', () => {
  it('show=true のとき、他の状態（activeModal 相当）に一切依存せずダイアログが描画される', () => {
    // このコンポーネントのシグネチャには activeModal が存在しない。
    // = 「AI生成中に activeModal が null であっても中止確認モーダルは表示される」
    // ことが型レベルで保証されていることを、実レンダリングでも確認する。
    act(() => {
      root.render(
        h(CancelGenerationConfirmModal, {
          show: true,
          onCancel: () => {},
          onConfirm: () => {},
        })
      );
    });
    const dialog = getDialog();
    expect(dialog, 'show=true で role="dialog" が描画されていません（中止確認モーダルに到達不能）').not.toBeNull();
    expect(container.textContent).toContain('AI献立の生成を中止しますか？');
  });

  it('show=false のときはダイアログが描画されない', () => {
    act(() => {
      root.render(
        h(CancelGenerationConfirmModal, {
          show: false,
          onCancel: () => {},
          onConfirm: () => {},
        })
      );
    });
    expect(getDialog()).toBeNull();
  });

  it('「中止する」ボタンをクリックすると onConfirm（= handleCancelGeneration 相当）が呼ばれる', () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        h(CancelGenerationConfirmModal, {
          show: true,
          onCancel: () => {},
          onConfirm,
        })
      );
    });
    const confirmBtn = findButtonByText('中止する');
    expect(confirmBtn, '「中止する」ボタンが見つかりません').toBeTruthy();
    act(() => {
      confirmBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('「キャンセル」ボタンをクリックすると onCancel が呼ばれ、onConfirm は呼ばれない', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        h(CancelGenerationConfirmModal, {
          show: true,
          onCancel,
          onConfirm,
        })
      );
    });
    const cancelBtn = findButtonByText('キャンセル');
    expect(cancelBtn).toBeTruthy();
    act(() => {
      cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('show を false→true に切り替えると、その都度ダイアログが到達可能になる（生成の再開始をシミュレート）', () => {
    act(() => {
      root.render(h(CancelGenerationConfirmModal, { show: false, onCancel: () => {}, onConfirm: () => {} }));
    });
    expect(getDialog()).toBeNull();

    act(() => {
      root.render(h(CancelGenerationConfirmModal, { show: true, onCancel: () => {}, onConfirm: () => {} }));
    });
    expect(getDialog()).not.toBeNull();

    act(() => {
      root.render(h(CancelGenerationConfirmModal, { show: false, onCancel: () => {}, onConfirm: () => {} }));
    });
    expect(getDialog()).toBeNull();
  });
});
