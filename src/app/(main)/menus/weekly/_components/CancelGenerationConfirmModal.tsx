"use client";

import { X } from "lucide-react";
import { ConfirmDeleteModal } from "@/components/common/ConfirmDeleteModal";

export interface CancelGenerationConfirmModalProps {
  /** 表示するかどうか（page.tsx の showConfirmCancelGeneration） */
  show: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * UX2-11: AI献立生成の中止確認モーダル（window.confirm は使わず styled モーダルに統一）。
 *
 * #1050 round-2 で判明した重大バグの修正:
 * 以前は page.tsx 内で `{activeModal && (<>...この中止確認モーダル...</>)}` という
 * 大きな条件ブロックの内側にネストされていた。しかし AI 生成開始経路
 * （handleGenerateWeekly 等）は生成開始時に必ず `setActiveModal(null)` でモーダル一覧を
 * 閉じるため、生成中（＝ activeModal が null）は上記ブロックごと描画されず、
 * 「中止する」ボタンを押しても確認モーダルが一切表示されない＝
 * handleCancelGeneration に到達不能という死コード状態だった。
 *
 * この意図的な独立コンポーネント化により、呼び出し側の型シグネチャに `activeModal` が
 * 存在しないため、このモーダルの表示可否が activeModal に依存する形へ後戻りすることを
 * コンパイル時点である程度防ぐ。page.tsx 側では、この呼び出しを
 * `{activeModal && (...)}` ゲートの外側（独立した <AnimatePresence>）に置くことで
 * 生成中でも到達可能にしている（その配置は
 * src/__tests__/app/menus/weekly/cancel-generation-modal-reachability.test.ts で
 * AST ベースに検証する）。
 */
export function CancelGenerationConfirmModal({
  show,
  onCancel,
  onConfirm,
}: CancelGenerationConfirmModalProps) {
  if (!show) return null;

  return (
    <ConfirmDeleteModal
      title="AI献立の生成を中止しますか？"
      message={
        <>
          ここまでの進捗表示を停止します。バックグラウンドの処理が完了している場合、<br />
          後で献立に反映されることがあります。
        </>
      }
      isDeleting={false}
      tone="neutral"
      icon={X}
      confirmLabel="中止する"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
