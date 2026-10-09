/**
 * /super-admin/exports/new — 新規エクスポートリクエスト (準備中・未対応)
 *
 * 依頼フォームは取り除いた (#1126)。ファイルを作る処理が無く、依頼しても完成しないため。
 * オーナー判断 (2026-10-08) で、作るまでは「準備中（未対応）」と明示する。API (POST /api/super-admin/exports) も 501 を返す。
 *
 * 見た目は、layout (背景が明るい) に合わせた明るい配色にする (一覧の画面と同じ。理由は ../page.tsx)。
 */
import Link from "next/link";
import { PreparingNotice } from "@/components/operator/PreparingNotice";

export default function NewExportPage() {
  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <Link href="/super-admin/exports" className="text-slate-400 hover:text-slate-600 transition-colors">
          ← データエクスポート
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-slate-900 mb-6">新規エクスポートリクエスト</h1>

      <PreparingNotice title="準備中（未対応）" tone="light">
        <p>データのエクスポート機能は、まだ作られていないため、依頼できません。</p>
        <p>依頼を受け付けても、ファイルを作る処理がなく、完成しないままになってしまうためです。</p>
      </PreparingNotice>
    </div>
  );
}
