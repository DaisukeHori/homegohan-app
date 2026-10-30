'use client';

/**
 * 営業 CRM 見込み顧客一覧 (カンバン + テーブルビュー)
 * operator/03-ui-spec.md §17 準拠
 * 権限: sales, admin, super_admin
 *
 * #2107 Y11: ステージの絞り込みを変えて読み込みを始めるときに行を空にする。そのあとの読み込みが失敗
 * (500・403・通信の失敗・壊れた応答) しても、前の条件の行と件数を失敗の文と一緒に出さない (新しい条件の結果と見誤らせない)。
 * 読み込みを重ねたときは、遅れて届いた古い読み込みの結果で新しい条件の画面を上書きしない (読み込みの連番で捨てる)。
 * 読み込みの最中・失敗のあいだは件数を出さない (前の条件の件数を新しい条件の件数と見せない)
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { loginPathWithNext } from '@/lib/auth/signed-in-user';
import { forbiddenMessageOfResponse } from '@/lib/admin/api-error-message';
import {
  AdminScreenError,
  adminLoadFailedFallback,
  adminLoadFailedMessage,
  displayableAdminError,
  listRowsOfBody,
  listTotalOfBody,
} from '@/lib/admin/admin-screen-messages';

/** 読み込みの失敗の文の対象 (「リードの一覧を読み込めませんでした (HTTP 502)」。#2086 V6) */
const LEADS_SUBJECT = 'リードの一覧';

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
  // ログインが切れた (401) ときに、ログインし直したあとこの画面へ戻れるよう next に付けるパス (#2101 X5)
  const pathname = usePathname();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [stageFilter, setStageFilter] = useState<Stage | ''>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'kanban' | 'table'>('kanban');
  // 読み込みを重ねたとき、古い読み込みの結果で新しい条件の画面を上書きしないための連番 (#2107 Y11)
  const loadSeqRef = useRef(0);

  const perPage = 200;

  const fetchLeads = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const isLatest = () => seq === loadSeqRef.current;
    setIsLoading(true);
    setError(null);
    // 前の条件の行を、新しい条件の読み込みの結果 (とくに失敗) と一緒に出さない (#2107 Y11)
    setLeads([]);
    try {
      const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
      if (stageFilter) params.set('stage', stageFilter);

      let res: Response;
      try {
        res = await fetch(`/api/admin/sales/leads?${params}`);
      } catch {
        // 通信そのものの失敗 (ブラウザの英字の例外の文を出さない。#2086 V6)
        throw new AdminScreenError(adminLoadFailedMessage(LEADS_SUBJECT, null));
      }
      if (!isLatest()) return;
      if (res.status === 401) { router.push(loginPathWithNext(pathname)); return; }
      // 403 は本文の理由の文 (二段階認証の確認が要る など) を捨てずに出す。それ以外は「権限がありません」(#1917)
      if (res.status === 403) {
        const forbiddenMessage = await forbiddenMessageOfResponse(res);
        if (isLatest()) setError(forbiddenMessage);
        return;
      }
      if (!res.ok) throw new AdminScreenError(adminLoadFailedMessage(LEADS_SUBJECT, res.status));

      const json: unknown = await res.json().catch(() => null);
      if (!isLatest()) return;
      // 200 なのに本文が読めない・data が配列でない壊れた応答は、0 件と見せずに読み込めなかったものとして扱う (#2101 X8)
      const rows = listRowsOfBody<Lead>(json);
      if (rows === null) throw new AdminScreenError(adminLoadFailedMessage(LEADS_SUBJECT, null));
      setLeads(rows);
      setTotal(listTotalOfBody(json));
    } catch (e: unknown) {
      // 画面に出すのは日本語の文だけ (JSON でない本文の SyntaxError などの英字の文は出さない。#2086 V6)
      if (isLatest()) setError(displayableAdminError(e, adminLoadFailedFallback(LEADS_SUBJECT)));
    } finally {
      if (isLatest()) setIsLoading(false);
    }
  }, [page, stageFilter, router, pathname]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  // 読み込みに失敗して出せる行が無い。「見込み顧客 0 件」・空のカンバン・「リードはありません」と 0 件に見せない (#2101 X8)
  const loadFailedWithoutRows = error !== null && leads.length === 0;
  // 件数 (total) が今の条件の読み込みの結果か。読み込みの最中・失敗のあいだの total は前の条件の件数なので出さない (#2107 Y11)
  const showsCurrentTotal = !isLoading && error === null;

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
            {showsCurrentTotal && <p className="text-sm text-gray-500 mt-1">見込み顧客 {total} 件</p>}
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
              href="/admin/sales/new"
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
        ) : loadFailedWithoutRows ? null : viewMode === 'kanban' ? (
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
                      href={`/admin/sales/${lead.id}`}
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
                        <Link href={`/admin/sales/${lead.id}`} className="text-blue-600 hover:text-blue-800 text-sm">
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
