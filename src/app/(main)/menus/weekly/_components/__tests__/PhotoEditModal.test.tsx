// src/app/(main)/menus/weekly/_components/__tests__/PhotoEditModal.test.tsx
// #2047: 写真から入力は、解析の結果が献立に書かれるまでモーダルを開いたまま「AIが解析中...」を出して待つ。
// そのあいだに送った写真を足す・消すと、待ち終えたときに「送った写真のままか」で写真を消すかを決める page.tsx の判定が崩れるので、
// 解析中は写真の追加・削除のボタンを押せないようにする。解析中でなければ押せる (今までどおり)。
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

const { PhotoEditModal } = await import('../modals/PhotoEditModal');
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

function renderModal(isAnalyzingPhoto: boolean, onRemovePhoto = vi.fn()) {
  act(() => {
    root.render(
      <PhotoEditModal
        isAnalyzingPhoto={isAnalyzingPhoto}
        onClose={vi.fn()}
        onPhotoSelect={vi.fn()}
        onRemovePhoto={onRemovePhoto}
        onAnalyze={vi.fn()}
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
