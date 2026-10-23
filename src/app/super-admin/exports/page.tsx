/**
 * /super-admin/exports — データエクスポート
 *
 * データの書き出し機能は、ファイルを作る処理 (cron / worker) も専用テーブルも無い (#1126)。
 * 以前の画面は、依頼を受け付けて「処理中」と表示するだけで、ファイルが完成することは一度もなかった。
 * #1911: 未完成の機能は画面に出さない (「準備中」とも出さない)。サイドバーにも並べず、URL で開かれたら 404 にする。
 * API (/api/super-admin/exports) は 501 を返す (変えていない)。
 */
import { notFound } from "next/navigation";

export default function ExportsPage(): never {
  notFound();
}
