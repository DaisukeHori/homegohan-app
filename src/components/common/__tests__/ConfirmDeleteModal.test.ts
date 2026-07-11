// src/components/common/__tests__/ConfirmDeleteModal.test.ts
// #1050 (UX2-04/UX2-05): 破壊操作の確認モーダルを共通の BottomSheet に載せ替えたことを検証する。
// - 既存の確認/キャンセル挙動（後方互換）が保たれていること
// - role="dialog" / aria-modal / Escape クローズ等、以前は無かった a11y が備わったこと

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ConfirmDeleteModal } from '../ConfirmDeleteModal';

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

describe('ConfirmDeleteModal: 既存の確認/キャンセル挙動 (後方互換)', () => {
  it('確認ボタンをクリックすると onConfirm が呼ばれる', () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        h(ConfirmDeleteModal, {
          title: '削除しますか？',
          message: '取り消せません',
          isDeleting: false,
          onCancel: () => {},
          onConfirm,
        })
      );
    });
    const buttons = container.querySelectorAll('button');
    const confirmBtn = Array.from(buttons).find((b) => b.textContent?.includes('削除する'));
    expect(confirmBtn).toBeTruthy();
    act(() => {
      confirmBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('キャンセルボタンをクリックすると onCancel が呼ばれる', () => {
    const onCancel = vi.fn();
    act(() => {
      root.render(
        h(ConfirmDeleteModal, {
          title: '削除しますか？',
          message: '取り消せません',
          isDeleting: false,
          onCancel,
          onConfirm: () => {},
        })
      );
    });
    const buttons = container.querySelectorAll('button');
    const cancelBtn = Array.from(buttons).find((b) => b.textContent?.includes('キャンセル'));
    act(() => {
      cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('confirmLabel/tone/icon を渡すとボタン文言とアイコンが変わる（UX2-11 の中止確認等での再利用）', () => {
    act(() => {
      root.render(
        h(ConfirmDeleteModal, {
          title: '中止しますか？',
          message: '進捗が止まります',
          isDeleting: false,
          onCancel: () => {},
          onConfirm: () => {},
          confirmLabel: '中止する',
          tone: 'neutral',
        })
      );
    });
    expect(container.textContent).toContain('中止する');
    expect(container.textContent).not.toContain('削除する');
  });

  it('isDeleting=true のとき確認ボタンが disabled になる', () => {
    act(() => {
      root.render(
        h(ConfirmDeleteModal, {
          title: '削除しますか？',
          message: '取り消せません',
          isDeleting: true,
          onCancel: () => {},
          onConfirm: () => {},
        })
      );
    });
    const buttons = container.querySelectorAll('button');
    // isDeleting 中はスピナー表示になり「削除する」ラベルは消える
    const confirmBtn = buttons[1] as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });
});

describe('ConfirmDeleteModal: BottomSheet 化による新規 a11y (#1050 UX2-05)', () => {
  it('role="dialog" / aria-modal="true" / aria-labelledby がタイトルを指す', () => {
    act(() => {
      root.render(
        h(ConfirmDeleteModal, {
          title: '削除しますか？',
          message: '取り消せません',
          isDeleting: false,
          onCancel: () => {},
          onConfirm: () => {},
        })
      );
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog!.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const labelEl = document.getElementById(labelledBy!);
    expect(labelEl?.textContent).toBe('削除しますか？');
  });

  it('Escape キーで onCancel が呼ばれる（従来は無かった閉じる導線）', () => {
    const onCancel = vi.fn();
    act(() => {
      root.render(
        h(ConfirmDeleteModal, {
          title: '削除しますか？',
          message: '取り消せません',
          isDeleting: false,
          onCancel,
          onConfirm: () => {},
        })
      );
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('isOpen=false を明示的に渡すと何も描画しない（新しい controlled 使用パターン）', () => {
    act(() => {
      root.render(
        h(ConfirmDeleteModal, {
          title: '削除しますか？',
          message: '取り消せません',
          isDeleting: false,
          onCancel: () => {},
          onConfirm: () => {},
          isOpen: false,
        })
      );
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('ConfirmDeleteModal: hideOverlayBackground (#1050 round-2 E, 二重backdrop対策)', () => {
  it('既定では背景を表示する（他ルートからの再利用時の見た目を変えない）', () => {
    act(() => {
      root.render(
        h(ConfirmDeleteModal, {
          title: '削除しますか？',
          message: '取り消せません',
          isDeleting: false,
          onCancel: () => {},
          onConfirm: () => {},
        })
      );
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.style.background).toBe('rgba(0, 0, 0, 0.5)');
  });

  it('hideOverlayBackground=true を BottomSheet まで転送し、背景を出さない', () => {
    act(() => {
      root.render(
        h(ConfirmDeleteModal, {
          title: '削除しますか？',
          message: '取り消せません',
          isDeleting: false,
          onCancel: () => {},
          onConfirm: () => {},
          hideOverlayBackground: true,
        })
      );
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.style.background).toBe('transparent');
  });
});
