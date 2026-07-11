"use client";

// src/components/common/useDialogA11y.ts
// #1052 (体系的 a11y): weekly の19モーダルのうち、既存の「自前 motion.div ルート」型
// （BottomSheet を使わない旧実装。バックドロップは page.tsx 側の共有 {activeModal && ...}
// が担う）のモーダルに、BottomSheet と同じ a11y の仕組み（Escape クローズ・背景スクロール
// ロック）を、DOM 構造を変えずに後付けするための軽量フック。
//
// DOM を大きく作り替えず最小差分で適用するため、role="dialog"/aria-modal/aria-labelledby
// と FocusTrap でのラップは呼び出し側（各モーダルコンポーネント）で行う。このフックは
// 「開いている間だけ dialogStack に自分の id を積み、最前面のときだけ Escape で閉じる」
// 「開いている間だけ背景スクロールをロックする」の2点のみを担当する。
//
// dialogStack を BottomSheet.tsx と共有しているため、BottomSheet ベースのダイアログ
// （例: ConfirmDeleteModal）がこのフック採用のレガシーモーダルの上に重ねて開いた場合でも、
// Escape は正しく最前面の1枚だけを閉じる（#1050 round-2 で解決済みの多重発火防止を維持）。

import { useEffect, useRef, useId } from "react";
import { lockBodyScroll, unlockBodyScroll, pushOpenDialog, popOpenDialog, isTopmostOpenDialog } from "./dialogStack";

export interface UseDialogA11yOptions {
  /**
   * このダイアログが開いているか。省略時は true（=マウントされている間は常に開いている
   * とみなす）。weekly の大半のモーダルは `{activeModal === 'xxx' && <XxxModal/>}` の
   * ようにマウント自体が「開く」を表すため、これが既定の使い方になる。
   */
  isOpen?: boolean;
  /** 閉じる要求（Escape）が起きたときに呼ばれる */
  onClose: () => void;
  /** Escape キーで閉じるか（既定: true） */
  closeOnEscape?: boolean;
}

export function useDialogA11y({ isOpen = true, onClose, closeOnEscape = true }: UseDialogA11yOptions) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dialogId = useId();

  // 背景スクロールロック
  useEffect(() => {
    if (!isOpen) return;
    lockBodyScroll();
    return () => unlockBodyScroll();
  }, [isOpen]);

  // 開いている間だけ自分の id を dialogStack に積む
  useEffect(() => {
    if (!isOpen) return;
    pushOpenDialog(dialogId);
    return () => popOpenDialog(dialogId);
  }, [isOpen, dialogId]);

  // Escape クローズ（最前面のときだけ）
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopmostOpenDialog(dialogId)) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeOnEscape, dialogId]);

  return { dialogId };
}
