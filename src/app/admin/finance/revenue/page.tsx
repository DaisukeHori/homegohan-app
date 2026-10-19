/**
 * /admin/finance/revenue — 収益推移
 *
 * 収益の日次スナップショット (revenue_snapshots) を作る集計バッチが無く、表は一件も埋まらない (#1125)。
 * #1911: 未完成の機能は画面に出さない (「準備中」とも出さない)。売上・経理のクイックリンクにも並べず、URL で開かれたら 404 にする。
 * 収益の API (/api/admin/finance/revenue) はそのまま残してある。
 */
import { notFound } from "next/navigation";

export default function RevenuePage(): never {
  notFound();
}
