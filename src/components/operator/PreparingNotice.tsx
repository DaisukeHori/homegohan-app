/**
 * 運営画面の「準備中 (未対応)」の案内ボックス (#1126 #1128 #1180 #1125)
 *
 * まだ作っていない機能 (データの書き出し・AI コンテンツの審査・インフラ監視・課金) を、
 * 「空の一覧」や「0 件 = 問題なし」に見せず、「まだ動いていない」と明示するための共通部品。
 * 緑の ✅ や「該当なし」ではなく、注意を表す琥珀色で出す。
 *
 * 配色は画面ごとに違うので tone で選ぶ。
 *   - dark:  super_admin の画面。ほかのカード (bg-slate-800) と同じ暗いカードにする。
 *            super-admin の layout の背景は明るい (bg-slate-50) ので、背景が透ける色にすると文字が読めなくなる。
 *            背景を塗りつぶした (不透明な) 色にして、どちらの背景に置いても読めるようにする
 *   - light: admin の画面 (明るい背景)
 */
import type { ReactNode } from 'react';

export type PreparingNoticeTone = 'dark' | 'light';

const TONE_CLASSES: Record<PreparingNoticeTone, { box: string; title: string; body: string }> = {
  dark: {
    box: 'bg-slate-800 border-amber-600',
    title: 'text-amber-300',
    body: 'text-slate-300',
  },
  light: {
    box: 'bg-amber-50 border-amber-200',
    title: 'text-amber-900',
    body: 'text-amber-800',
  },
};

export function PreparingNotice({
  title,
  tone = 'dark',
  className = '',
  children,
}: {
  /** 見出し (例: 「準備中（未対応）」)。画面の主なメッセージ */
  title: string;
  tone?: PreparingNoticeTone;
  className?: string;
  /** 補足の説明 */
  children?: ReactNode;
}) {
  const classes = TONE_CLASSES[tone];
  return (
    <div role="status" className={`rounded-xl border p-6 ${classes.box} ${className}`.trim()}>
      <p className={`text-base font-semibold ${classes.title}`}>{title}</p>
      {children ? <div className={`mt-2 space-y-2 text-sm leading-relaxed ${classes.body}`}>{children}</div> : null}
    </div>
  );
}
