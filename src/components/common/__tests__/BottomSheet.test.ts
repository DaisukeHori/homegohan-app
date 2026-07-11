// src/components/common/__tests__/BottomSheet.test.ts
// #1050 (UX2-05): 共通 BottomSheet の基本 a11y（Escape クローズ・背景クリック・
// フォーカス移動・背景スクロールロック）を検証する。
//
// NOTE: このリポジトリの vitest 設定は tsconfig の jsx:"preserve" と非互換のため、
// 既存の modal-contracts.test.ts / progress-todo-card-cancel.test.ts に倣い
// 拡張子 .ts + React.createElement で JSX 構文を回避する。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

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

describe('BottomSheet: 表示制御 (#1050 UX2-05)', () => {
  it('isOpen=false のときは何もレンダリングしない', () => {
    act(() => {
      root.render(h(BottomSheet, { isOpen: false, onClose: () => {} }, h('p', null, '中身')));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('isOpen=true のとき role="dialog" / aria-modal="true" でレンダリングされる', () => {
    act(() => {
      root.render(
        h(BottomSheet, { isOpen: true, onClose: () => {}, ariaLabel: 'テストダイアログ' }, h('p', null, '中身'))
      );
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    expect(dialog!.getAttribute('aria-label')).toBe('テストダイアログ');
    expect(container.textContent).toContain('中身');
  });

  it('ariaLabelledBy を渡すと aria-label ではなく aria-labelledby が使われる', () => {
    act(() => {
      root.render(
        h(
          BottomSheet,
          { isOpen: true, onClose: () => {}, ariaLabel: '無視されるはず', ariaLabelledBy: 'my-heading' },
          h('h2', { id: 'my-heading' }, '見出し')
        )
      );
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog!.getAttribute('aria-labelledby')).toBe('my-heading');
    expect(dialog!.hasAttribute('aria-label')).toBe(false);
  });
});

describe('BottomSheet: Escape クローズ (#1050 UX2-05)', () => {
  it('Escape キーで onClose が呼ばれる', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(h(BottomSheet, { isOpen: true, onClose }, h('p', null, '中身')));
    });
    act(() => {
      pressEscape();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closeOnEscape=false のときは Escape で onClose が呼ばれない', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        h(BottomSheet, { isOpen: true, onClose, closeOnEscape: false }, h('p', null, '中身'))
      );
    });
    act(() => {
      pressEscape();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('isOpen=false のときは Escape を押しても onClose が呼ばれない（リスナーが残らない）', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(h(BottomSheet, { isOpen: false, onClose }, h('p', null, '中身')));
    });
    act(() => {
      pressEscape();
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('BottomSheet: 背景クリック (#1050 UX2-05)', () => {
  it('背景（オーバーレイ）クリックで onClose が呼ばれる', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(h(BottomSheet, { isOpen: true, onClose }, h('p', null, '中身')));
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    act(() => {
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('パネル内部のクリックでは onClose が呼ばれない（stopPropagation）', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        h(BottomSheet, { isOpen: true, onClose, testId: 'sheet' }, h('button', { 'data-testid': 'inner-btn' }, 'ボタン'))
      );
    });
    const innerBtn = container.querySelector('[data-testid="inner-btn"]') as HTMLElement;
    act(() => {
      innerBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closeOnOverlayClick=false のときは背景クリックでも onClose が呼ばれない', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        h(BottomSheet, { isOpen: true, onClose, closeOnOverlayClick: false }, h('p', null, '中身'))
      );
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    act(() => {
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('BottomSheet: フォーカス移動 (#1050 UX2-05)', () => {
  it('開いたときにフォーカスがダイアログ内に移動する（body に残らない）', async () => {
    act(() => {
      root.render(
        h(BottomSheet, { isOpen: true, onClose: () => {} }, h('button', { 'data-testid': 'focus-target' }, '押す'))
      );
    });
    // focus-trap は既定で delayInitialFocus: true（内部で setTimeout(fn, 0) により初期フォーカスを
    // 当てる）ため、マクロタスクを1つ消化してから検証する。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe('BottomSheet: 背景スクロールロック (#1050 UX2-05)', () => {
  it('開いている間は document.body.style.overflow が hidden になる', () => {
    act(() => {
      root.render(h(BottomSheet, { isOpen: true, onClose: () => {} }, h('p', null, '中身')));
    });
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('閉じる（isOpen=false に変わる）と overflow が元に戻る', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(h(BottomSheet, { isOpen: true, onClose }, h('p', null, '中身')));
    });
    expect(document.body.style.overflow).toBe('hidden');
    act(() => {
      root.render(h(BottomSheet, { isOpen: false, onClose }, h('p', null, '中身')));
    });
    expect(document.body.style.overflow).toBe('');
  });
});
