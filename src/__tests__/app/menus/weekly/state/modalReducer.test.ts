// src/__tests__/app/menus/weekly/state/modalReducer.test.ts
// Issue #2047: 写真から入力は、解析の結果を待ち終えてからモーダルを閉じる (MODAL_CLOSE_PHOTO_EDIT_SESSION)。
// 待つあいだ (最大 2 分) に利用者がモーダルを閉じた・別の献立や同じ献立の写真のモーダルを開き直した・ほかのモーダルを開いたなら、
// それは閉じない。見分けは献立の id ではなく、モーダルを開いた回 (photoEditSession) で行う (同じ献立を開き直すと別の回)。
// 判定は dispatch した時点の状態で行う (待ち始めたときの状態のクロージャで setActiveModal(null) すると、開き直したモーダルまで閉じる)。

import { describe, it, expect } from 'vitest';
import type { PlannedMeal } from '@/types/domain';
import {
  modalReducer,
  initialModalState,
  type ModalState,
} from '@/app/(main)/menus/weekly/_state/reducers/modalReducer';
import {
  aiGenerationReducer,
  initialAiGenerationState,
  photoAnalyzeStateForSession,
} from '@/app/(main)/menus/weekly/_state/reducers/aiGenerationReducer';

const WAITED_MEAL_ID = 'meal-waited';
const OTHER_MEAL_ID = 'meal-other';
const waitedMeal = { id: WAITED_MEAL_ID } as PlannedMeal;
const otherMeal = { id: OTHER_MEAL_ID } as PlannedMeal;

/** 写真から入力のモーダルを、待っていた献立で開いた状態 (1 回目) */
function openedForWaitedMeal(): ModalState {
  return modalReducer(initialModalState, { type: 'MODAL_OPEN_PHOTO_EDIT', payload: waitedMeal });
}

/** 利用者が × で閉じる (page.tsx の PhotoEditModal の onClose と同じ dispatch: setActiveModal(null) → setPhotoEditMeal(null)) */
function closeByUser(state: ModalState): ModalState {
  const closed = modalReducer(state, { type: 'MODAL_OPEN', payload: null });
  return modalReducer(closed, { type: 'MODAL_SET_PHOTO_EDIT_MEAL', payload: null });
}

describe('modalReducer: MODAL_OPEN_PHOTO_EDIT (#2047)', () => {
  it('写真から入力のモーダルをその献立で開き、開いた回を 1 つ進める', () => {
    const opened = openedForWaitedMeal();
    expect(opened.activeModal).toBe('photoEdit');
    expect(opened.photoEditMeal).toBe(waitedMeal);
    expect(opened.photoEditSession).toBe(initialModalState.photoEditSession + 1);
  });

  it('同じ献立で開き直しても、別の回になる', () => {
    const first = openedForWaitedMeal();
    const reopened = modalReducer(closeByUser(first), { type: 'MODAL_OPEN_PHOTO_EDIT', payload: waitedMeal });
    expect(reopened.photoEditMeal).toBe(waitedMeal);
    expect(reopened.photoEditSession).not.toBe(first.photoEditSession);
  });
});

describe('modalReducer: MODAL_CLOSE_PHOTO_EDIT_SESSION (#2047)', () => {
  it('写真から入力のモーダルが、解析を頼んだ回のままなら閉じる', () => {
    const open = openedForWaitedMeal();
    const next = modalReducer(open, { type: 'MODAL_CLOSE_PHOTO_EDIT_SESSION', payload: open.photoEditSession });
    expect(next.activeModal).toBeNull();
    expect(next.photoEditMeal).toBeNull();
  });

  it('別の献立の写真から入力のモーダルは閉じない', () => {
    const waited = openedForWaitedMeal();
    const other = modalReducer(closeByUser(waited), { type: 'MODAL_OPEN_PHOTO_EDIT', payload: otherMeal });
    const next = modalReducer(other, { type: 'MODAL_CLOSE_PHOTO_EDIT_SESSION', payload: waited.photoEditSession });
    expect(next).toBe(other);
  });

  it('同じ献立で開き直したモーダルは閉じない (献立の id が同じでも、待ち始めたときのモーダルではない)', () => {
    const waited = openedForWaitedMeal();
    const reopened = modalReducer(closeByUser(waited), { type: 'MODAL_OPEN_PHOTO_EDIT', payload: waitedMeal });
    const next = modalReducer(reopened, { type: 'MODAL_CLOSE_PHOTO_EDIT_SESSION', payload: waited.photoEditSession });
    expect(next).toBe(reopened);
    expect(next.activeModal).toBe('photoEdit');
    expect(next.photoEditMeal).toBe(waitedMeal);
  });

  it('ほかのモーダル (手で編集 など) は閉じない', () => {
    const waited = openedForWaitedMeal();
    const manual = modalReducer(waited, { type: 'MODAL_OPEN', payload: 'manualEdit' });
    const next = modalReducer(manual, { type: 'MODAL_CLOSE_PHOTO_EDIT_SESSION', payload: waited.photoEditSession });
    expect(next).toBe(manual);
  });

  it('利用者が閉じたあと (モーダルなし) は何も変えない', () => {
    const waited = openedForWaitedMeal();
    const closed = closeByUser(waited);
    const next = modalReducer(closed, { type: 'MODAL_CLOSE_PHOTO_EDIT_SESSION', payload: waited.photoEditSession });
    expect(next).toBe(closed);
  });
});

describe('写真の解析の結果を待つあいだに開いたモーダル (#2047: modalReducer の回 × aiGenerationReducer の解析中の回)', () => {
  /** 献立 A のモーダル (1 回目) で解析を始め、利用者が閉じたあと、next の写真から入力のモーダルを開いた状態 */
  function waitingThenOpen(next: PlannedMeal) {
    const waited = openedForWaitedMeal();
    const analyzing = aiGenerationReducer(initialAiGenerationState, {
      type: 'PHOTO_ANALYZE_START',
      payload: { session: waited.photoEditSession },
    });
    const opened = modalReducer(closeByUser(waited), { type: 'MODAL_OPEN_PHOTO_EDIT', payload: next });
    return { waited, analyzing, opened };
  }

  it('別の献立 B のモーダルには「解析中」を出さず other (前の写真の結果を待っている) とする。待ち終えても B は閉じず、B で解析できる', () => {
    const { waited, analyzing, opened } = waitingThenOpen(otherMeal);
    expect(photoAnalyzeStateForSession(analyzing, waited.photoEditSession)).toBe('own');
    expect(photoAnalyzeStateForSession(analyzing, opened.photoEditSession)).toBe('other');

    const afterWait = modalReducer(opened, { type: 'MODAL_CLOSE_PHOTO_EDIT_SESSION', payload: waited.photoEditSession });
    const ended = aiGenerationReducer(analyzing, { type: 'PHOTO_ANALYZE_END' });
    expect(afterWait.activeModal).toBe('photoEdit');
    expect(afterWait.photoEditMeal).toBe(otherMeal);
    expect(photoAnalyzeStateForSession(ended, afterWait.photoEditSession)).toBe('idle');
  });

  it('同じ献立 A を開き直したモーダルも other とし、待ち終えても閉じない', () => {
    const { waited, analyzing, opened } = waitingThenOpen(waitedMeal);
    expect(photoAnalyzeStateForSession(analyzing, opened.photoEditSession)).toBe('other');
    const afterWait = modalReducer(opened, { type: 'MODAL_CLOSE_PHOTO_EDIT_SESSION', payload: waited.photoEditSession });
    expect(afterWait).toBe(opened);
  });
});
