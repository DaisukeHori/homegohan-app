/**
 * /super-admin/exports — データエクスポート (準備中・未対応)
 *
 * データの書き出し機能は、ファイルを作る処理 (cron / worker) も専用テーブルも無い (#1126)。
 * 以前の画面は、依頼を受け付けて「処理中」と表示するだけで、ファイルが完成することは一度もなかった
 * (一覧は本人の GDPR 削除要求の表を代用して読んでいた)。
 * オーナー判断 (2026-10-08) で、作るまでは「準備中（未対応）」と明示する。API (/api/super-admin/exports) も 501 を返す。
 *
 * 見た目は、layout (背景が明るい) に合わせた明るい配色にする。以前の画面の見出しは白文字 (text-white) で、
 * 明るい背景の上ではほとんど読めなかった。
 */
import { PreparingNotice } from "@/components/operator/PreparingNotice";

export default function ExportsPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">データエクスポート</h1>
        <p className="text-sm text-slate-500 mt-1">DB のデータの書き出し</p>
      </div>

      <PreparingNotice title="準備中（未対応）" tone="light">
        <p>データのエクスポート機能は、まだ作られていません。</p>
        <p>
          依頼を受け付けても、ファイルを作る処理がありません。完成しない依頼が「処理中」のまま残らないよう、
          依頼の画面と一覧を止めています。
        </p>
      </PreparingNotice>
    </div>
  );
}
