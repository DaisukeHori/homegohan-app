"use client";

/**
 * #132 組織向け UI — 最小実装
 * org_admin ロールを持つユーザーのみアクセス可能。
 * /api/org/departments から部署一覧を取得して表示する。
 * 編集機能は次回 issue で実装予定。
 */

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

interface Department {
  id: string;
  name: string;
  parentId: string | null;
  managerId: string | null;
  displayOrder: number;
  memberCount: number;
  createdAt: string;
}

export default function OrgPage() {
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const init = async () => {
      // ログイン確認
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push('/login');
        return;
      }

      // org_admin ロール確認
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('roles, organization_id')
        .eq('id', user.id)
        .single();

      if (!profile?.roles?.includes('org_admin') || !profile?.organization_id) {
        setForbidden(true);
        setLoading(false);
        return;
      }

      // 部署一覧取得
      try {
        const res = await fetch('/api/org/departments');
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        const json = await res.json();
        setDepartments(json.departments ?? []);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    init();
  }, [supabase, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-400 text-sm">読み込み中…</div>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <div className="text-4xl">🔒</div>
        <h1 className="text-xl font-bold text-gray-700">アクセス権がありません</h1>
        <p className="text-gray-500 text-sm text-center">
          このページは組織管理者 (org_admin) のみ閲覧できます。
        </p>
        <button
          onClick={() => router.back()}
          className="mt-2 px-4 py-2 rounded-full bg-gray-100 text-gray-600 text-sm font-medium hover:bg-gray-200 transition-colors"
        >
          戻る
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* ヘッダー */}
      <div className="bg-white p-6 pb-4 border-b border-gray-100 sticky top-0 z-20">
        <h1 className="text-2xl font-bold text-gray-900">組織管理</h1>
        <p className="text-xs text-gray-400 mt-1">org_admin 専用ページ</p>
      </div>

      <div className="p-6 space-y-6">

        {/* 部署一覧 */}
        <div>
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 pl-2">
            部署一覧
          </h2>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600">
              エラー: {error}
            </div>
          )}

          {!error && departments.length === 0 && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
              <div className="text-4xl mb-3">🏢</div>
              <p className="text-gray-500 text-sm">部署がまだ登録されていません。</p>
            </div>
          )}

          {departments.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              {departments.map((dept, idx) => (
                <div
                  key={dept.id}
                  className={`flex items-center justify-between p-4 ${
                    idx < departments.length - 1 ? 'border-b border-gray-50' : ''
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-500">
                      🏢
                    </div>
                    <div>
                      <span className="font-bold text-gray-700">{dept.name}</span>
                      {dept.parentId && (
                        <p className="text-xs text-gray-400">サブ部署</p>
                      )}
                    </div>
                  </div>
                  <span className="text-sm text-gray-400">{dept.memberCount} 名</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 今後の機能について */}
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <p className="text-sm text-amber-700 font-medium mb-1">編集機能は準備中</p>
          <p className="text-xs text-amber-600">
            部署の追加・編集・削除は次期アップデートで実装予定です。
          </p>
        </div>

      </div>
    </div>
  );
}
