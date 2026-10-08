'use client';

/**
 * 財務ダッシュボード (/admin/finance) のクイックリンク (#1311)
 *
 * NPS / CSAT のページと NPS の書き出しは、admin / super_admin だけが使える (財務ロール finance は外した)。
 * 使えない人にリンクを見せないため、NPS / CSAT のリンクは「書き出せる種別」に nps がある人にだけ出す。
 *
 * 誰が使えるかの判定はサーバーが持つ。画面で役割を判定し直すと、API の判定とずれてしまうので、
 * 呼んだ本人が書き出せる種別を返す GET /api/admin/finance/exports (nps は admin / super_admin にだけ入る) を見て決める。
 * リンクを隠すのは見た目の整理で、実際に止めているのは API (NPS / CSAT の集計も書き出しも finance は 403)。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface QuickLink {
  href: string;
  label: string;
  icon: string;
  /** 指定した種別が「書き出せる種別」にあるときだけ出す。指定が無いリンクは常に出す */
  requiresExportType?: string;
}

const QUICK_LINKS: QuickLink[] = [
  { href: '/admin/finance/revenue', label: '収益推移グラフ', icon: '📈' },
  { href: '/admin/finance/invoices', label: '請求書一覧', icon: '🧾' },
  { href: '/admin/finance/reconciliation', label: 'Stripe 整合チェック', icon: '🔄' },
  { href: '/admin/finance/nps', label: 'NPS / CSAT', icon: '⭐', requiresExportType: 'nps' },
  { href: '/admin/finance/exports', label: 'CSV エクスポート', icon: '📥' },
];

/** GET /api/admin/finance/exports の応答から、書き出せる種別を取り出す。形が違えば空 */
function readAvailableTypes(json: unknown): string[] {
  const types = (json as { data?: { available_types?: unknown } } | null)?.data?.available_types;
  return Array.isArray(types) ? types.filter((type): type is string => typeof type === 'string') : [];
}

export default function FinanceQuickLinks() {
  // null = まだ分からない。分かるまで並びを出さない
  // (NPS / CSAT のリンクが後から割り込んで、ほかのリンクの位置が動くのを避ける)
  const [exportTypes, setExportTypes] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/finance/exports')
      .then((res) => (res.ok ? res.json() : null))
      .then((json: unknown) => {
        if (!cancelled) setExportTypes(readAvailableTypes(json));
      })
      // 取れなかったときは、NPS / CSAT のリンクだけ隠す (使えるか分からない人に出さない側に倒す)
      .catch(() => {
        if (!cancelled) setExportTypes([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (exportTypes === null) return null;

  const links = QUICK_LINKS.filter(
    (link) => link.requiresExportType === undefined || exportTypes.includes(link.requiresExportType),
  );

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      {links.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="bg-white border border-slate-100 rounded-xl p-4 flex items-center gap-3 hover:border-indigo-200 hover:shadow-sm transition-all"
        >
          <span className="text-2xl">{item.icon}</span>
          <span className="text-sm font-medium text-slate-700">{item.label}</span>
        </Link>
      ))}
    </div>
  );
}
