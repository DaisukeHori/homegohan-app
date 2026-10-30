/**
 * /super-admin/feature-packages — 機能パッケージ一覧
 * operator/01-data-model.md §3.3 準拠
 *
 * DB 直叩きを廃止し GET /api/super-admin/feature-packages 経由に統一。
 */

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireRoleForPage } from '@/lib/auth/page-guard';
import { adminFetch } from '@/lib/admin/fetch';
import { listRowsOfBody } from '@/lib/admin/admin-screen-messages';

interface FeaturePackage {
  id: string;
  package_key: string;
  display_name: string;
  description: string | null;
  feature_flags: string[] | null;
  status: string;
  display_order: number;
}

export default async function FeaturePackagesPage() {
  // 未認証 → /login?next=・2FA 未完了 → MFA の画面・ロール不足 / 凍結 → /login (#1176。docs/design/cross/12-operator-mfa.md §13.4.2)
  await requireRoleForPage(['super_admin'], { next: '/super-admin/feature-packages' });

  // GET /api/super-admin/feature-packages 経由でデータ取得
  let packages: FeaturePackage[] = [];
  let fetchError = false;

  try {
    const res = await adminFetch('/api/super-admin/feature-packages?per_page=100');
    if (res.ok) {
      // 200 なのに本文が読めない・data が配列でない壊れた応答は、0 件と見せずに取得の失敗として扱う (#2101 X8)
      const rows = listRowsOfBody<FeaturePackage>(await res.json().catch(() => null));
      if (rows === null) {
        fetchError = true;
        console.error('[super-admin/feature-packages page] malformed list body');
      } else {
        packages = rows;
      }
    } else {
      fetchError = true;
      console.error('[super-admin/feature-packages page] API error:', res.status);
    }
  } catch (err) {
    fetchError = true;
    console.error('[super-admin/feature-packages page] fetch failed:', err);
  }

  return (
    <div>
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">機能パッケージ</h1>
          <p className="text-sm text-slate-500 mt-1">feature_packages — プランに付与する機能フラグのバンドル</p>
        </div>
        <Link
          href="/super-admin/feature-packages/new"
          className="px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors"
        >
          + 新規作成
        </Link>
      </div>

      {fetchError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
          データの取得に失敗しました
        </div>
      )}

      <div className="grid gap-4">
        {packages.map((pkg) => (
          <div key={pkg.id} className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <code className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">{pkg.package_key}</code>
                  <h3 className="text-base font-semibold text-slate-800">{pkg.display_name}</h3>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    pkg.status === 'active'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-slate-100 text-slate-500'
                  }`}>
                    {pkg.status === 'active' ? '有効' : '廃止'}
                  </span>
                </div>
                {pkg.description && (
                  <p className="text-sm text-slate-500 mb-3">{pkg.description}</p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {(pkg.feature_flags ?? []).map((flag: string) => (
                    <span
                      key={flag}
                      className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded font-mono"
                    >
                      {flag}
                    </span>
                  ))}
                </div>
              </div>
              <Link
                href={`/super-admin/feature-packages/${pkg.id}`}
                className="ml-4 text-orange-500 hover:text-orange-600 text-sm font-medium flex-shrink-0"
              >
                編集
              </Link>
            </div>
          </div>
        ))}
        {packages.length === 0 && !fetchError && (
          <div className="bg-white rounded-xl border border-slate-200 px-4 py-8 text-center text-slate-400">
            機能パッケージがありません
          </div>
        )}
      </div>
    </div>
  );
}
