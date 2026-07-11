"use client";

import React from "react";
import { Trash2, type LucideIcon } from "lucide-react";
import { BottomSheet } from "./BottomSheet";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#767676', // #1052 (コントラスト): #A0A0A0 (白地で約2.7:1) から WCAG AA相当の #767676 (約4.5:1) へ
  danger: '#D64545',
  dangerLight: '#FDECEC',
  neutral: '#E07A5F',
  neutralLight: '#FDF0ED',
};

interface ConfirmDeleteModalProps {
  /** モーダルタイトル（例: 「この食事を削除しますか？」） */
  title: string;
  /** 削除対象の説明文（例: 「〇〇を削除します。この操作は取り消せません。」） */
  message: React.ReactNode;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** UX2-11: 削除以外の破壊的でない確認（中止など）にも流用できるよう一般化 */
  confirmLabel?: string;
  icon?: LucideIcon;
  /** 'danger'（既定・削除系）/ 'neutral'（中止など取り消し可能な操作） */
  tone?: 'danger' | 'neutral';
  /**
   * #1050: 呼び出し元が `{cond && <ConfirmDeleteModal .../>}` のように条件付きマウントで
   * 使う既存パターンとの後方互換のため既定 true（マウントされている間は常に開いているとみなす）。
   * 常時マウントして isOpen で開閉を切り替える新しい使い方をする場合は明示的に渡す。
   */
  isOpen?: boolean;
  /**
   * #1050 round-2 (E, Sonnet5 Suggestion): 呼び出し元が既に別の半透明背景（例:
   * weekly page.tsx の {activeModal && ...} 共有バックドロップ）の内側でこのモーダルを
   * 使う場合、BottomSheet 自身の背景を重ねて二重に暗くなるのを避けるためのオプション。
   * 既定 false（従来どおり自前の背景を表示。他ルートからの再利用ではこの既定を維持する）。
   */
  hideOverlayBackground?: boolean;
}

// #1053: 削除確認の見た目を weekly 全体で統一するため、
// 表示テキストは呼び出し元から渡す汎用コンポーネントに一般化（旧: 食事削除専用の固定文言）。
// UX2-11: confirmLabel/icon/tone を追加し、削除以外の確認（AI生成の中止など）にも再利用可能にした。
// #1050 (UX2-04/UX2-05): 破壊操作の確認モーダルを1箇所に統一する「reuse 先」として、
// 共通の BottomSheet（role=dialog/aria-modal/フォーカストラップ/Escape/背景スクロールロック）の
// 上に載せ替えた。以前 menus/weekly 配下にあったものを共有コンポーネントへ移設し、
// pantry・meals/new・V4GenerateModal 等の他ルートからも再利用できるようにしている。
export function ConfirmDeleteModal({
  title,
  message,
  isDeleting,
  onCancel,
  onConfirm,
  confirmLabel = '削除する',
  icon: Icon = Trash2,
  tone = 'danger',
  isOpen = true,
  hideOverlayBackground = false,
}: ConfirmDeleteModalProps) {
  const toneColor = tone === 'danger' ? colors.danger : colors.neutral;
  const toneColorLight = tone === 'danger' ? colors.dangerLight : colors.neutralLight;
  const titleId = React.useId();

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onCancel}
      ariaLabelledBy={titleId}
      overlayClassName="z-[202]"
      panelClassName="w-full max-w-sm rounded-2xl p-5"
      panelStyle={{ background: colors.card }}
      testId="confirm-delete-modal"
      hideOverlayBackground={hideOverlayBackground}
    >
      <div className="flex flex-col items-center text-center mb-5">
        <div className="w-14 h-14 rounded-full flex items-center justify-center mb-3" style={{ background: toneColorLight }}>
          <Icon size={24} color={toneColor} />
        </div>
        <h3 id={titleId} style={{ fontSize: 17, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
          {title}
        </h3>
        <p style={{ fontSize: 13, color: colors.textMuted, margin: 0 }}>
          {message}
        </p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="flex-1 py-3 rounded-xl"
          style={{ background: colors.bg }}
        >
          <span style={{ fontSize: 14, fontWeight: 500, color: colors.textLight }}>キャンセル</span>
        </button>
        <button
          onClick={onConfirm}
          disabled={isDeleting}
          className="flex-1 py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60"
          style={{ background: toneColor }}
        >
          {isDeleting ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              <Icon size={14} color="#fff" />
              <span style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>{confirmLabel}</span>
            </>
          )}
        </button>
      </div>
    </BottomSheet>
  );
}
