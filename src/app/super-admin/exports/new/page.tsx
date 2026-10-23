/**
 * /super-admin/exports/new — 新規エクスポートリクエスト
 *
 * 依頼フォームは取り除いた (#1126)。ファイルを作る処理が無く、依頼しても完成しないため。
 * #1911: 未完成の機能は画面に出さない (「準備中」とも出さない)。URL で開かれたら 404 にする。
 * API (POST /api/super-admin/exports) は 501 を返す (変えていない)。
 */
import { notFound } from "next/navigation";

export default function NewExportPage(): never {
  notFound();
}
