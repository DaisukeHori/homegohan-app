// src/__tests__/app/menus/weekly/state/modalReducer.test.ts
// Issue #2047: 写真から入力は、解析の結果を待ち終えてからモーダルを閉じる (MODAL_CLOSE_PHOTO_EDIT_FOR_MEAL)。
// 待っているあいだに利用者がモーダルを閉じた・別の献立の写真のモーダルやほかのモーダルを開いたなら、それは閉じない。
// 判定は dispatch した時点の状態で行う (待ち始めたときの状態のクロージャで setActiveModal(null) すると、開き直したモーダルまで閉じる)。

import { describe, it, expect } from 'vitest';
import type { PlannedMeal } from '@/types/domain';
import {
  modalReducer,
  initialModalState,
  type ModalState,
} from '@/app/(main)/menus/weekly/_state/reducers/modalReducer';

const WAITED_MEAL_ID = 'meal-waited';
const OTHER_MEAL_ID = 'meal-other';
const waitedMeal = { id: WAITED_MEAL_ID } as PlannedMeal;
const otherMeal = { id: OTHER_MEAL_ID } as PlannedMeal;

describe('modalReducer: MODAL_CLOSE_PHOTO_EDIT_FOR_MEAL (#2047)', () => {
  it('写真から入力のモーダルが、待っていた献立のものなら閉じる', () => {
    const open: ModalState = { ...initialModalState, activeModal: 'photoEdit', photoEditMeal: waitedMeal };
    const next = modalReducer(open, { type: 'MODAL_CLOSE_PHOTO_EDIT_FOR_MEAL', payload: WAITED_MEAL_ID });
    expect(next.activeModal).toBeNull();
    expect(next.photoEditMeal).toBeNull();
  });

  it('別の献立の写真から入力のモーダルは閉じない', () => {
    const open: ModalState = { ...initialModalState, activeModal: 'photoEdit', photoEditMeal: otherMeal };
    const next = modalReducer(open, { type: 'MODAL_CLOSE_PHOTO_EDIT_FOR_MEAL', payload: WAITED_MEAL_ID });
    expect(next).toBe(open);
  });

  it('ほかのモーダル (手で編集 など) は閉じない', () => {
    const open: ModalState = { ...initialModalState, activeModal: 'manualEdit', photoEditMeal: waitedMeal };
    const next = modalReducer(open, { type: 'MODAL_CLOSE_PHOTO_EDIT_FOR_MEAL', payload: WAITED_MEAL_ID });
    expect(next).toBe(open);
  });

  it('利用者が閉じたあと (モーダルなし) は何も変えない', () => {
    const next = modalReducer(initialModalState, { type: 'MODAL_CLOSE_PHOTO_EDIT_FOR_MEAL', payload: WAITED_MEAL_ID });
    expect(next).toBe(initialModalState);
  });
});
