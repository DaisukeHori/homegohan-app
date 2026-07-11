"use client";

// src/components/common/BottomSheet.tsx
// #1050 (UX2-05): モーダル群にダイアログ a11y 実装がほぼ無い問題への対応として新設した
// 共通アクセシブルダイアログ・プリミティブ。role="dialog"/aria-modal/フォーカストラップ/
// Escape クローズ/背景スクロールロックの基本 a11y を1箇所に集約する。
//
// 位置づけ: このコンポーネント自体は「基本の土台」に留める（visualViewport 対応や
// 既存19モーダルへの網羅的な適用は #1052 の範囲）。#1050 では破壊操作の確認モーダル
// (ConfirmDeleteModal) をこの上に載せ替え、新規追加する確認ダイアログ類から再利用する。
//
// 名称は Issue (#1050 UX2-05) の「共通 BottomSheet」に合わせているが、実体は画面下部
// 固定に限定されないアクセシブルモーダルの汎用ラッパーであり、`position` prop で
// 「中央配置のダイアログ」「下部シート」いずれの見た目にも使える。

import React, { useEffect, useId, useRef } from "react";
import FocusTrap from "focus-trap-react";
import { AnimatePresence, motion } from "framer-motion";

export interface BottomSheetProps {
  /** 表示するかどうか。false の間は何もレンダリングしない（AnimatePresence が exit アニメーションを担当） */
  isOpen: boolean;
  /** 背景クリック・Escape・閉じるボタン等で閉じる要求が起きたときに呼ばれる */
  onClose: () => void;
  // 任意化: React.createElement(BottomSheet, props, ...children) のように rest 引数で
  // children を渡すテストコード（jsx:"preserve" 非互換回避のための .createElement 記法）で、
  // TS が「props オブジェクトに children が無い」と誤検知するのを避けるため optional にする
  // （実行時は React が rest 引数から children を補完するため挙動は変わらない）。
  children?: React.ReactNode;
  /** ダイアログの見出しテキスト。aria-label として使う（見出し要素を別途表示している場合は ariaLabelledBy を優先） */
  ariaLabel?: string;
  /** 既に画面内に見出し要素があり、それを aria-labelledby で参照したい場合の要素 id */
  ariaLabelledBy?: string;
  /** 背景クリックで閉じるか（既定: true） */
  closeOnOverlayClick?: boolean;
  /** Escape キーで閉じるか（既定: true） */
  closeOnEscape?: boolean;
  /** 'center'（既定、中央配置のダイアログ）/ 'bottom'（画面下部からせり上がるシート） */
  position?: "center" | "bottom";
  /** パネル（内容側）に付与する追加クラス。位置・サイズ等の上書き用 */
  panelClassName?: string;
  /** パネル（内容側）に付与する追加インラインスタイル（背景色等、Tailwind に無い値を渡す用） */
  panelStyle?: React.CSSProperties;
  /** オーバーレイ（背景）に付与する追加クラス。z-index の上書き等 */
  overlayClassName?: string;
  /** data-testid（テスト・E2E 用） */
  testId?: string;
}

const DEFAULT_OVERLAY_CLASS = "fixed inset-0 z-50 flex p-4";
const POSITION_CLASS: Record<NonNullable<BottomSheetProps["position"]>, string> = {
  center: "items-center justify-center",
  bottom: "items-end justify-center sm:items-center",
};

/**
 * 背景スクロールロック。BottomSheet が開いている間、body のスクロールを止める。
 * 複数の BottomSheet が同時に開いても、最後に閉じたものが元の overflow に復元する
 * ようネストカウントで管理する。
 */
let scrollLockCount = 0;
let previousBodyOverflow: string | null = null;

function lockBodyScroll() {
  if (typeof document === "undefined") return;
  if (scrollLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLockCount += 1;
}

function unlockBodyScroll() {
  if (typeof document === "undefined") return;
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = previousBodyOverflow ?? "";
    previousBodyOverflow = null;
  }
}

/**
 * #1050 round-2 (#1052 地雷の先回り, Opus 発見の Should 指摘):
 * BottomSheet は各インスタンスが独自に document レベルの keydown リスナーを登録して
 * Escape を処理する。複数の BottomSheet が同時に開いている（入れ子/重ね掛け）場合、
 * stopPropagation() は同一ターゲット(document)に登録された他のリスナーには効かないため、
 * 1回の Escape で登録済みの全 BottomSheet が同時に閉じてしまっていた。
 *
 * 開いている BottomSheet の id をスタックで管理し、Escape ハンドラは
 * 「自分が最上位（最後に開いた = 最前面）かどうか」を判定してから処理することで、
 * 何個開いていても最前面の1枚だけが閉じるようにする。
 */
const openSheetStack: string[] = [];

function pushOpenSheet(id: string) {
  if (!openSheetStack.includes(id)) {
    openSheetStack.push(id);
  }
}

function popOpenSheet(id: string) {
  const idx = openSheetStack.indexOf(id);
  if (idx !== -1) {
    openSheetStack.splice(idx, 1);
  }
}

function isTopmostOpenSheet(id: string): boolean {
  return openSheetStack[openSheetStack.length - 1] === id;
}

export function BottomSheet({
  isOpen,
  onClose,
  children,
  ariaLabel,
  ariaLabelledBy,
  closeOnOverlayClick = true,
  closeOnEscape = true,
  position = "center",
  panelClassName = "",
  panelStyle,
  overlayClassName = "",
  testId,
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const sheetId = useId();

  // 背景スクロールロック
  useEffect(() => {
    if (!isOpen) return;
    lockBodyScroll();
    return () => unlockBodyScroll();
  }, [isOpen]);

  // #1050 round-2: 開いている間だけ自分の id を「開いている BottomSheet スタック」に積む。
  // closeOnEscape の有無に関わらず登録する（最前面が closeOnEscape=false の場合に
  // Escape がその下の BottomSheet まで「素通り」して閉じてしまうのを防ぐため）。
  useEffect(() => {
    if (!isOpen) return;
    pushOpenSheet(sheetId);
    return () => popOpenSheet(sheetId);
  }, [isOpen, sheetId]);

  // Escape クローズ（FocusTrap 側の escapeDeactivates は使わず、ここで一元管理する）。
  // #1050 round-2 (#1052 地雷の先回り): 複数の BottomSheet が同時に開いていても、
  // 自分がスタック最上位（＝最前面）のときだけ閉じる。stopPropagation() は同一ターゲット
  // (document) の他リスナーには効かないため、判定自体で多重発火を防ぐ。
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopmostOpenSheet(sheetId)) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeOnEscape, sheetId]);

  return (
    <AnimatePresence>
      {isOpen && (
        <FocusTrap
          focusTrapOptions={{
            allowOutsideClick: true,
            escapeDeactivates: false,
            // フォーカス可能な要素が内容に無いケース（例: メッセージのみの確認ダイアログ）でも
            // エラーにならないよう、パネル自体をフォールバックのフォーカス先にする。
            fallbackFocus: () => panelRef.current ?? document.body,
          }}
        >
          <motion.div
            data-testid={testId}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabelledBy ? undefined : ariaLabel}
            aria-labelledby={ariaLabelledBy}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={`${DEFAULT_OVERLAY_CLASS} ${POSITION_CLASS[position]} ${overlayClassName}`}
            style={{ background: "rgba(0,0,0,0.5)" }}
            onClick={() => {
              if (closeOnOverlayClick) onCloseRef.current();
            }}
          >
            <motion.div
              ref={panelRef}
              tabIndex={-1}
              initial={position === "bottom" ? { y: "100%" } : { opacity: 0, scale: 0.95 }}
              animate={position === "bottom" ? { y: 0 } : { opacity: 1, scale: 1 }}
              exit={position === "bottom" ? { y: "100%" } : { opacity: 0, scale: 0.95 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className={panelClassName}
              style={panelStyle}
              onClick={(e) => e.stopPropagation()}
            >
              {children}
            </motion.div>
          </motion.div>
        </FocusTrap>
      )}
    </AnimatePresence>
  );
}
