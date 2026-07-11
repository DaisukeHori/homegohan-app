// src/components/common/__tests__/useDialogA11y.test.ts
// #1052 (体系的 a11y): weekly の19モーダルのうち BottomSheet を使わない「自前 motion.div
// ルート」型モーダルに Escape クローズ/背景スクロールロックを後付けするための
// useDialogA11y フックを検証する。BottomSheet.tsx と dialogStack を共有しているため、
// 「useDialogA11y 採用のレガシーモーダル」の上に「BottomSheet ベースの確認ダイアログ
// （例: ShoppingModal 表示中の全削除確認）」が重ねて開いた場合でも、Escape が正しく
// 最前面の1枚だけを閉じることを実際に検証する（#1050 round-2 で解決した多重発火防止が
// レガシーモーダル側にも及んでいることの担保）。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { useDialogA11y } from '../useDialogA11y';
import { BottomSheet } from '../BottomSheet';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  document.body.style.overflow = '';
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.style.overflow = '';
});

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

// useDialogA11y を使う最小限の「レガシーモーダル」風コンポーネント
function LegacyModal({ onClose, testId }: { onClose: () => void; testId: string }) {
  useDialogA11y({ onClose });
  return h('div', { 'data-testid': testId, role: 'dialog', 'aria-modal': 'true' }, 'legacy modal content');
}

describe('useDialogA11y: Escape クローズ (#1052)', () => {
  it('マウントされている間に Escape を押すと onClose が呼ばれる', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(h(LegacyModal, { onClose, testId: 'legacy' }));
    });
    act(() => {
      pressEscape();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('unmount 後は Escape を押しても onClose が呼ばれない（リスナーが残らない）', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(h(LegacyModal, { onClose, testId: 'legacy' }));
    });
    act(() => {
      root.render(h('div'));
    });
    act(() => {
      pressEscape();
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('useDialogA11y: 背景スクロールロック (#1052)', () => {
  it('マウント中は document.body.style.overflow が hidden になり、unmount で復元される', () => {
    act(() => {
      root.render(h(LegacyModal, { onClose: () => {}, testId: 'legacy' }));
    });
    expect(document.body.style.overflow).toBe('hidden');
    act(() => {
      root.render(h('div'));
    });
    expect(document.body.style.overflow).toBe('');
  });
});

describe('useDialogA11y と BottomSheet の Escape スタック共有 (#1052, #1050 round-2 の多重発火防止の継承)', () => {
  it('レガシーモーダル(useDialogA11y)の上に BottomSheet ベースの確認ダイアログを重ねて開くと、Escape は最前面の BottomSheet だけを閉じる', () => {
    const onCloseLegacy = vi.fn();
    const onCloseSheet = vi.fn();

    // レガシーモーダルを開く（例: ShoppingModal 相当）
    act(() => {
      root.render(
        h(
          React.Fragment,
          null,
          h(LegacyModal, { onClose: onCloseLegacy, testId: 'legacy' })
        )
      );
    });

    // その上に BottomSheet ベースの確認ダイアログを重ねて開く（例: 全削除確認）
    act(() => {
      root.render(
        h(
          React.Fragment,
          null,
          h(LegacyModal, { onClose: onCloseLegacy, testId: 'legacy' }),
          h(BottomSheet, { isOpen: true, onClose: onCloseSheet, testId: 'confirm' }, h('p', null, '確認'))
        )
      );
    });

    act(() => {
      pressEscape();
    });

    expect(onCloseSheet, '最前面の BottomSheet が閉じていません').toHaveBeenCalledTimes(1);
    expect(onCloseLegacy, '背面のレガシーモーダルまで閉じています（多重発火の回帰）').not.toHaveBeenCalled();
  });

  it('前面の BottomSheet を閉じた後にもう一度 Escape を押すと、今度は背面のレガシーモーダルが閉じる', () => {
    const onCloseLegacy = vi.fn();

    act(() => {
      root.render(h(LegacyModal, { onClose: onCloseLegacy, testId: 'legacy' }));
    });
    act(() => {
      root.render(
        h(
          React.Fragment,
          null,
          h(LegacyModal, { onClose: onCloseLegacy, testId: 'legacy' }),
          h(BottomSheet, { isOpen: true, onClose: () => {}, testId: 'confirm' }, h('p', null, '確認'))
        )
      );
    });
    // BottomSheet を閉じる(isOpen: false)
    act(() => {
      root.render(
        h(
          React.Fragment,
          null,
          h(LegacyModal, { onClose: onCloseLegacy, testId: 'legacy' }),
          h(BottomSheet, { isOpen: false, onClose: () => {}, testId: 'confirm' }, h('p', null, '確認'))
        )
      );
    });

    act(() => {
      pressEscape();
    });

    expect(onCloseLegacy, 'BottomSheet を閉じた後は背面のレガシーモーダルが最前面になるはず').toHaveBeenCalledTimes(1);
  });
});
