// src/app/(main)/menus/weekly/_components/__tests__/PhotoEditModal.test.tsx
// #2047: 写真から入力は、解析の結果が献立に書かれるまでモーダルを開いたまま「AIが解析中...」を出して待つ。
// そのあいだに送った写真を足す・消すと、待ち終えたときに「送った写真のままか」で写真を消すかを決める page.tsx の判定が崩れるので、
// 解析中は写真の追加・削除のボタンを押せないようにする。解析中でなければ押せる (今までどおり)。
// また、待つあいだに利用者が閉じて開いた別のモーダル (別の献立・同じ献立の開き直し) では、前のモーダルで送った写真の結果を
// 待っている (isOtherPhotoAnalyzing) ので、「AIが解析中...」は出さずその旨の案内を出し、写真は選べるが解析のボタンは押せない。
// このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。

import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  // next/image の最適化を通さず、渡された src をそのまま img に出す
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));
// アニメーションは描画の確認に要らない
vi.mock('framer-motion', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { motion: new Proxy({}, { get: () => passthrough }) };
});
// フォーカストラップは描画の確認に要らない (jsdom ではフォーカスできる要素の判定が当てにならない)
vi.mock('focus-trap-react', () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

const { PhotoEditModal, OTHER_PHOTO_ANALYZING_NOTICE } = await import('../modals/PhotoEditModal');
const { useFormDraftStore } = await import('../../_state');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PREVIEW = 'data:image/png;base64,AAAA';
const SELECTED_PHOTO = new File(['x'], 'meal.png', { type: 'image/png' });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useFormDraftStore.getState().setPhotoFiles([SELECTED_PHOTO]);
  useFormDraftStore.getState().setPhotoPreviews([PREVIEW]);
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
  useFormDraftStore.getState().setPhotoFiles([]);
  useFormDraftStore.getState().setPhotoPreviews([]);
  document.body.style.overflow = '';
});

function renderModal(
  isAnalyzingPhoto: boolean,
  onRemovePhoto = vi.fn(),
  { isOtherPhotoAnalyzing = false, onAnalyze = vi.fn() }: { isOtherPhotoAnalyzing?: boolean; onAnalyze?: () => void } = {},
) {
  act(() => {
    root.render(
      <PhotoEditModal
        isAnalyzingPhoto={isAnalyzingPhoto}
        isOtherPhotoAnalyzing={isOtherPhotoAnalyzing}
        onClose={vi.fn()}
        onPhotoSelect={vi.fn()}
        onRemovePhoto={onRemovePhoto}
        onAnalyze={onAnalyze}
      />,
    );
  });
  return onRemovePhoto;
}

function removeButton(): HTMLButtonElement | null {
  return container.querySelector('button[aria-label="写真1を削除"]');
}

function addButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '追加');
}

function analyzeButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('AIで解析'));
}

describe('PhotoEditModal: 解析中は送った写真を変えられない (#2047)', () => {
  it('解析中は、写真の削除・追加のボタンが押せない (押しても消さない) — 解析中の表示は出す', () => {
    const onRemovePhoto = renderModal(true);
    expect(container.textContent).toContain('AIが解析中...');
    expect(removeButton()?.disabled).toBe(true);
    expect(addButton()?.disabled).toBe(true);
    act(() => {
      removeButton()?.click();
    });
    expect(onRemovePhoto).not.toHaveBeenCalled();
  });

  it('解析中でなければ、写真の削除・追加のボタンを押せる (今までどおり)', () => {
    const onRemovePhoto = renderModal(false);
    expect(removeButton()?.disabled).toBe(false);
    expect(addButton()?.disabled).toBe(false);
    act(() => {
      removeButton()?.click();
    });
    expect(onRemovePhoto).toHaveBeenCalledWith(0);
  });
});

describe('PhotoEditModal: 前のモーダルで送った写真の結果を待っているあいだ (#2047)', () => {
  it('「AIが解析中...」は出さず案内を出し、写真を選んでいても解析のボタンは押せない (押しても解析しない)', () => {
    const onAnalyze = vi.fn();
    renderModal(false, vi.fn(), { isOtherPhotoAnalyzing: true, onAnalyze });
    expect(container.textContent).not.toContain('AIが解析中...');
    expect(container.querySelector('[role="status"]')?.textContent).toBe(OTHER_PHOTO_ANALYZING_NOTICE);
    expect(analyzeButton()?.disabled).toBe(true);
    act(() => {
      analyzeButton()?.click();
    });
    expect(onAnalyze).not.toHaveBeenCalled();
  });

  it('このモーダルの写真は選び直せる (削除・追加のボタンを押せる)', () => {
    const onRemovePhoto = renderModal(false, vi.fn(), { isOtherPhotoAnalyzing: true });
    expect(removeButton()?.disabled).toBe(false);
    expect(addButton()?.disabled).toBe(false);
    act(() => {
      removeButton()?.click();
    });
    expect(onRemovePhoto).toHaveBeenCalledWith(0);
  });

  it('待っていなければ案内は出さず、写真を選んでいれば解析のボタンを押せる', () => {
    const onAnalyze = vi.fn();
    renderModal(false, vi.fn(), { onAnalyze });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(analyzeButton()?.disabled).toBe(false);
    act(() => {
      analyzeButton()?.click();
    });
    expect(onAnalyze).toHaveBeenCalledTimes(1);
  });
});
