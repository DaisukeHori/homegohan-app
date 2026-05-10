'use client';

/**
 * inactive owner / representative テーブルコンポーネント
 * docs/design/membership/05-operator-emergency-ui.md §6.2 準拠
 */

import Link from 'next/link';

export type InactiveOwner = {
  scope_id: string;
  scope_name: string;
  owner_id: string;
  owner_email: string;
  last_login_at: string | null;
};

type Props = {
  items: InactiveOwner[];
  scope: 'org' | 'family';
  onDissolve?: (item: InactiveOwner) => void;
};

function formatLastLogin(lastLoginAt: string | null): string {
  if (!lastLoginAt) return '未ログイン';
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(lastLoginAt));
  } catch {
    return lastLoginAt;
  }
}

export default function InactiveOwnerTable({ items, scope, onDissolve }: Props) {
  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500 text-sm">
        対象の{scope === 'org' ? '組織' : '家族グループ'}はありません
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-500">
            <th className="pb-3 pr-4 font-medium">{scope === 'org' ? '組織名' : '家族グループ名'}</th>
            <th className="pb-3 pr-4 font-medium">{scope === 'org' ? 'オーナー' : '代表者'}</th>
            <th className="pb-3 pr-4 font-medium">最終ログイン</th>
            <th className="pb-3 font-medium">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.map((item) => (
            <tr key={item.scope_id} className="hover:bg-gray-50">
              <td className="py-3 pr-4 font-medium text-gray-900">{item.scope_name}</td>
              <td className="py-3 pr-4 text-gray-600">{item.owner_email}</td>
              <td className="py-3 pr-4 text-gray-600">{formatLastLogin(item.last_login_at)}</td>
              <td className="py-3">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/operator/membership/${scope === 'org' ? 'orgs' : 'families'}/${item.scope_id}/transfer`}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    対応
                  </Link>
                  {onDissolve && (
                    <button
                      onClick={() => onDissolve(item)}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
                    >
                      解散
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
