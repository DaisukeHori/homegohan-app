'use client';

/**
 * 営業 CRM 見込み顧客一覧 (カンバン + テーブルビュー)
 * operator/03-ui-spec.md §17 準拠
 * 権限: sales, admin, super_admin
 */
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type Stage = 'approach' | 'meeting' | 'proposal' | 'negotiation' | 'won' | 'lost';

interface Lead {
  id: string;
  company_name: string;
  industry: string | null;
  contact_name: string | null;
  contact_email: string | null;
  stage: Stage;
  assigned_to: string | null;
  estimated_acv: number | null;
  created_at: string;
  updated_at: string;
}

const STAGE_LABELS: Record<Stage, string> = {
  approach: 'アプローチ',
  meeting: '商談中',
  proposal: '提案',
  negotiation: '交渉',
  won: '契約済',
  lost: '失注',
};

const STAGE_COLORS: Record<Stage, string> = {
  approach: 'bg-blue-50 border-blue-200',
  meeting: 'bg-yellow-50 border-yellow-200',
  proposal: 'bg-purple-50 border-purple-200',
  negotiation: 'bg-orange-50 border-orange-200',
  won: 'bg-green-50 border-green-200',
  lost: 'bg-gray-50 border-gray-200',
};

const ALL_STAGES: Stage[] = ['approach', 'meeting', 'proposal', 'negotiation', 'won', 'lost'];

export default function SalesLeadsPage() {
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [stageFilter, setStageFilter] = useState<Stage | ''>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'kanban' | 'table'>('kanban');

  const perPage = 200;

  const fetchLeads = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
      if (stageFilter) params.set('stage', stageFilter);

      const res = await fetch(`/api/admin/sales/leads?${params}`);
      if (res.status === 401) { router.push('/login'); return; }
      if (res.status === 403) { setError('権限がありません'); return; }
      if (!res.ok) throw new Error('一覧取得に失敗しました');

      const json = await res.json();
      setLeads(json.data ?? []);
      setTotal(json.meta?.total ?? 0);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '不明なエラー');
    } finally {
      setIsLoading(false);
    }
  }, [page, stageFilter, router]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  const leadsByStage = ALL_STAGES.reduce<Record<Stage, Lead[]>>((acc, stage) => {
    acc[stage] = leads.filter((l) => l.stage === stage);
    return acc;
  }, {} as Record<Stage, Lead[]>);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* ヘッダー */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">営業 CRM</h1>
            <p className="text-sm text-gray-500 mt-1">見込み顧客 {total} 件</p>
          </div>
          <div className="flex items-center gap-3">
            {/* ビュー切替 */}
            <div className="flex border border-gray-300 rounded-lg overflow-hidden text-sm">
              <button
                onClick={() => setViewMode('kanban')}
                className={`px-3 py-1.5 ${viewMode === 'kanban' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                カンバン
              </button>
              <button
                onClick={() => setViewMode('table')}
                className={`px-3 py-1.5 ${viewMode === 'table' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                テーブル
              </button>
            </div>
            <Link
              href="/sales/new"
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              + 新規リード
            </Link>
          </div>
        </div>

        {/* フィルタ (テーブルビュー用) */}
        {viewMode === 'table' && (
          <div className="flex items-center gap-3 mb-4">
            <label htmlFor="stage-filter" className="text-sm text-gray-500">ステージ:</label>
            <select
              id="stage-filter"
              value={stageFilter}
              onChange={(e) => { setStageFilter(e.target.value as Stage | ''); setPage(1); }}
              className="text-sm border border-gray-300 rounded px-2 py-1"
            >
              <option value="">すべて</option>
              {ALL_STAGES.map((s) => (
                <option key={s} value={s}>{STAGE_LABELS[s]}</option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 text-sm">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="text-center py-12 text-gray-500">読み込み中...</div>
        ) : viewMode === 'kanban' ? (
          /* カンバンビュー */
          <div className="flex gap-4 overflow-x-auto pb-4">
            {ALL_STAGES.map((stage) => (
              <div
                key={stage}
                className={`flex-shrink-0 w-64 rounded-lg border-2 ${STAGE_COLORS[stage]} p-3`}
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-700">{STAGE_LABELS[stage]}</h3>
                  <span className="text-xs text-gray-500 bg-white rounded-full px-2 py-0.5 border">
                    {leadsByStage[stage].length}
                  </span>
                </div>
                <div className="space-y-2">
                  {leadsByStage[stage].map((lead) => (
                    <Link
                      key={lead.id}
                      href={`/sales/${lead.id}`}
                      className="block bg-white rounded border border-gray-200 p-3 hover:shadow-sm transition-shadow"
                    >
                      <p className="text-sm font-medium text-gray-900 truncate">{lead.company_name}</p>
                      {lead.contact_name && (
                        <p className="text-xs text-gray-500 mt-0.5 truncate">{lead.contact_name}</p>
                      )}
                      {lead.estimated_acv != null && (
                        <p className="text-xs text-blue-600 mt-1">
                          ¥{lead.estimated_acv.toLocaleString()}
                        </p>
                      )}
                      <p className="text-xs text-gray-400 mt-1">
                        {new Date(lead.updated_at).toLocaleDateString('ja-JP')}
                      </p>
                    </Link>
                  ))}
                  {leadsByStage[stage].length === 0 && (
                    <p className="text-xs text-gray-400 text-center py-4">なし</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* テーブルビュー */
          <div className="bg-white rounded-lg shadow overflow-hidden">
            {leads.length === 0 ? (
              <div className="text-center py-12 text-gray-500">リードはありません</div>
            ) : (
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">会社名</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">担当者</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">ステージ</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">推定 ACV</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">最終更新</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {leads.map((lead) => (
                    <tr key={lead.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{lead.company_name}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{lead.contact_name ?? '-'}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700">
                          {STAGE_LABELS[lead.stage]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {lead.estimated_acv != null ? `¥${lead.estimated_acv.toLocaleString()}` : '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {new Date(lead.updated_at).toLocaleDateString('ja-JP')}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link href={`/sales/${lead.id}`} className="text-blue-600 hover:text-blue-800 text-sm">
                          詳細
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
