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

describe('BottomSheet: 入れ子（複数同時オープン）での Escape (#1050 round-2 Should, #1052 地雷の先回り)', () => {
  // 以前は各 BottomSheet が document レベルの keydown リスナーを個別に登録し
  // stopPropagation() のみで多重発火を防ごうとしていたが、stopPropagation() は
  // 同一ターゲット(document)の他リスナーには効かないため、#1052 で BottomSheet を
  // 入れ子/重ね掛けすると1回の Escape で全て同時に閉じてしまう実害があった。

  it('2枚重ねて Escape を押すと、後から開いた（最前面の）方だけが閉じる', () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();

    // まず A だけを開く
    act(() => {
      root.render(
        h(
          React.Fragment,
          null,
          h(BottomSheet, { isOpen: true, onClose: onCloseA, testId: 'sheet-a' }, h('p', null, 'A'))
        )
      );
    });

    // 続いて A を開いたまま B も開く（B が後から開いた = 最前面）
    act(() => {
      root.render(
        h(
          React.Fragment,
          null,
          h(BottomSheet, { isOpen: true, onClose: onCloseA, testId: 'sheet-a' }, h('p', null, 'A')),
          h(BottomSheet, { isOpen: true, onClose: onCloseB, testId: 'sheet-b' }, h('p', null, 'B'))
        )
      );
    });

    expect(container.querySelectorAll('[role="dialog"]').length).toBe(2);

    act(() => {
      pressEscape();
    });

    expect(onCloseB, '最前面(B)の onClose が呼ばれていません').toHaveBeenCalledTimes(1);
    expect(onCloseA, '背面(A)の onClose まで呼ばれています（多重発火の回帰）').not.toHaveBeenCalled();
  });

  it('最前面(B)を閉じた後にもう一度 Escape を押すと、今度は残っている A が閉じる', () => {
    const onCloseA = vi.fn();

    act(() => {
      root.render(
        h(
          React.Fragment,
          null,
          h(BottomSheet, { isOpen: true, onClose: onCloseA, testId: 'sheet-a' }, h('p', null, 'A'))
        )
      );
    });
    act(() => {
      root.render(
        h(
          React.Fragment,
          null,
          h(BottomSheet, { isOpen: true, onClose: onCloseA, testId: 'sheet-a' }, h('p', null, 'A')),
          h(BottomSheet, { isOpen: true, onClose: () => {}, testId: 'sheet-b' }, h('p', null, 'B'))
        )
      );
    });

    // B を閉じる（unmount 相当: isOpen=false にする）
    act(() => {
      root.render(
        h(
          React.Fragment,
          null,
          h(BottomSheet, { isOpen: true, onClose: onCloseA, testId: 'sheet-a' }, h('p', null, 'A')),
          h(BottomSheet, { isOpen: false, onClose: () => {}, testId: 'sheet-b' }, h('p', null, 'B'))
        )
      );
    });

    act(() => {
      pressEscape();
    });

    expect(onCloseA, 'B を閉じた後は A が最前面になり、Escape で閉じるはず').toHaveBeenCalledTimes(1);
  });

  it('最前面(B)が closeOnEscape=false の場合、Escape を押しても A・B どちらも閉じない（下のシートへの素通り防止）', () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();

    act(() => {
      root.render(
        h(
          React.Fragment,
          null,
          h(BottomSheet, { isOpen: true, onClose: onCloseA, testId: 'sheet-a' }, h('p', null, 'A'))
        )
      );
    });
    act(() => {
      root.render(
        h(
          React.Fragment,
          null,
          h(BottomSheet, { isOpen: true, onClose: onCloseA, testId: 'sheet-a' }, h('p', null, 'A')),
          h(
            BottomSheet,
            { isOpen: true, onClose: onCloseB, closeOnEscape: false, testId: 'sheet-b' },
            h('p', null, 'B')
          )
        )
      );
    });

    act(() => {
      pressEscape();
    });

    expect(onCloseB).not.toHaveBeenCalled();
    expect(onCloseA, '最前面が Escape 無効でも、下の A まで閉じてはいけない').not.toHaveBeenCalled();
  });

  it('isOpen=true のまま unmount（isOpen=false を経由しない DOM ツリーからの除去）されても openSheetStack から pop される（幽霊エントリ無し）', () => {
    // #1050 レビュー残ポリッシュ (Opus 再レビュー Suggestion): Escape クローズは
    // isTopmostOpenSheet(自分のid) === stack末尾 で判定するため、もし unmount 時に
    // pop が漏れて幽霊エントリがスタックに残ると、後から単独で開いた別の BottomSheet の
    // id が (ゴーストが上に居座って) 末尾ではなくなり、Escape を押しても
    // 自分がトップだと判定できず閉じなくなる。これを実際に検知できる形で検証する。
    const onCloseGhostSource = vi.fn();
    const onCloseB = vi.fn();

    // A（後で isOpen=false を経由せず、いきなりツリーから消す）を単独で開く
    act(() => {
      root.render(
        h(BottomSheet, { isOpen: true, onClose: onCloseGhostSource, testId: 'sheet-ghost' }, h('p', null, 'A'))
      );
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    // isOpen=false にはせず、コンポーネント自体をツリーから除去（真の unmount）。
    // React はこの場合も直前のエフェクトのクリーンアップ（popOpenSheet）を実行する。
    act(() => {
      root.render(h('div', null));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    // 直後に別の BottomSheet を単独で開く（スタックが正しく空なら、これが必ず最前面になる）
    act(() => {
      root.render(h(BottomSheet, { isOpen: true, onClose: onCloseB, testId: 'sheet-b' }, h('p', null, 'B')));
    });

    act(() => {
      pressEscape();
    });

    expect(
      onCloseB,
      '単独で開いた B が Escape で閉じません（先に unmount した A の幽霊エントリがスタック最上位に残っている疑い）'
    ).toHaveBeenCalledTimes(1);
    expect(onCloseGhostSource).not.toHaveBeenCalled();
  });
});

describe('BottomSheet: hideOverlayBackground (#1050 round-2 E, 二重backdrop対策)', () => {
  it('既定では自前の半透明背景 (rgba(0,0,0,0.5)) を表示する', () => {
    act(() => {
      root.render(h(BottomSheet, { isOpen: true, onClose: () => {} }, h('p', null, '中身')));
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.style.background).toBe('rgba(0, 0, 0, 0.5)');
  });

  it('hideOverlayBackground=true のときは背景を出さない（呼び出し元の共有バックドロップとの二重darkening回避）', () => {
    act(() => {
      root.render(
        h(BottomSheet, { isOpen: true, onClose: () => {}, hideOverlayBackground: true }, h('p', null, '中身'))
      );
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.style.background).toBe('transparent');
  });

  it('hideOverlayBackground=true でも背景クリックでの onClose は引き続き機能する（見た目のみの変更）', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        h(BottomSheet, { isOpen: true, onClose, hideOverlayBackground: true }, h('p', null, '中身'))
      );
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    act(() => {
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
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
