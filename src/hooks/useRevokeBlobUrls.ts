'use client';

import { useEffect, useRef } from 'react';
import { findRemovedUrls, revokeBlobUrls } from '@/lib/object-url';

type PreviewUrls = string | null | undefined | readonly string[];

const toUrlList = (urls: PreviewUrls): readonly string[] => {
  if (urls == null) return [];
  return typeof urls === 'string' ? [urls] : urls;
};

/**
 * #1222: プレビュー用 Blob URL (`URL.createObjectURL`) を、画面から外れたときに解放する。
 *
 * state に入れた URL (1 件でも配列でも) を渡すと、次のタイミングで `URL.revokeObjectURL` が呼ばれる。
 * - 差し替え・削除・リセットで、前回あって今回無くなった URL
 * - ページを離れる (アンマウント) とき、まだ残っている URL
 *
 * 「state を空にする」箇所が多いページ (meals/new は 16 箇所以上) でも、
 * 個別に revoke を書かずに済む。`blob:` 以外の値 (`'__pdf__'` や固定画像の URL) は無視される。
 *
 * 使い方の注意:
 * - URL は render 中ではなくイベントハンドラ内で作る (`URL.createObjectURL` を state 更新関数の中や
 *   render 中で呼ばない)。render 中に作った URL は、StrictMode の再マウントで解放済みになるおそれがある
 * - 配列は state と同じく、変更時に新しい配列を渡す (push などで直接書き換えない)
 */
export function useRevokeBlobUrls(urls: PreviewUrls): void {
  // 最後に画面へ反映された URL 一覧 (次回の差分比較とアンマウント時の解放に使う)
  const committedRef = useRef<readonly string[]>([]);

  useEffect(() => {
    const next = toUrlList(urls);
    revokeBlobUrls(findRemovedUrls(committedRef.current, next));
    committedRef.current = next;
  }, [urls]);

  useEffect(() => {
    return () => {
      revokeBlobUrls(committedRef.current);
      committedRef.current = [];
    };
  }, []);
}
