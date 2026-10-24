'use client';

/**
 * リード詳細 + 活動履歴 + ステージ変更
 * operator/03-ui-spec.md §17 準拠
 * 権限: sales, admin, super_admin
 */
import { useState, useEffect, useCallback, use } from 'react';
import { isStaleDataConflict } from '@/lib/admin/api-error-message';
import { todayLocal } from '@/lib/date-utils';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/**
 * ステージの変更が 409 CONFLICT_STALE_DATA (別の担当者が先にステージを変えた) で断られ、リードを読み直したときの文 (#1917)。
 * サーバーの文は「画面を開き直して」と頼む文なので使わない (画面が自分で読み直すため)
 */
const STALE_STAGE_MESSAGE =
  '別の担当者が先にこのリードのステージを変えていました。最新の内容を読み込み直したので、今のステージを確かめてから、もう一度変更してください';

/** 409 CONFLICT_STALE_DATA のあとのリードの読み直しにも失敗したときの文 (読み直せていないので「読み込み直した」とは言わない。#1917) */
const STALE_STAGE_RELOAD_FAILED_MESSAGE =
  '別の担当者が先にこのリードのステージを変えていました。最新の内容を読み込み直せなかったので、画面を読み込み直してから、もう一度変更してください';

/**
 * リードの読み込み (fetchLead) の結果。
 *   - loaded      : 読めた
 *   - unauthorized: 401 (ログインの画面へ移した)
 *   - forbidden   : 403 (「権限がありません」を出した)
 *   - not-found   : 404 (「リードが見つかりません」を出した)
 *   - failed      : そのほかの失敗 (「リードの取得に失敗しました」を出した)
 */
type LeadLoadOutcome = 'loaded' | 'unauthorized' | 'forbidden' | 'not-found' | 'failed';

/**
 * 409 CONFLICT_STALE_DATA のあとの読み直しの結果から、画面に出す文を決める (null = fetchLead が出した文をそのまま残す)。
 * 読み直しの間にリードが消えた (404)・権限が外れた (403)・ログインが切れた (401) ときは、その理由のほうが確かなので
 * 「画面を読み込み直して」の文で上書きしない (消えたリードに読み込み直しを促さない。#1917)
 */
function staleStageMessageOf(outcome: LeadLoadOutcome): string | null {
  switch (outcome) {
    case 'loaded':
      return STALE_STAGE_MESSAGE;
    case 'failed':
      return STALE_STAGE_RELOAD_FAILED_MESSAGE;
    case 'unauthorized':
    case 'forbidden':
    case 'not-found':
      return null;
  }
}

type Stage = 'approach' | 'meeting' | 'proposal' | 'negotiation' | 'won' | 'lost';
type ActivityType = 'call' | 'email' | 'meeting' | 'note' | 'stage_change';

interface Activity {
  id: string;
  actor_id: string;
  activity_type: ActivityType;
  details: Record<string, unknown>;
  created_at: string;
}

interface Lead {
  id: string;
  company_name: string;
  industry: string | null;
  employee_count: number | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  source: string | null;
  stage: Stage;
  assigned_to: string | null;
  estimated_acv: number | null;
  notes: string | null;
  converted_org_id: string | null;
  created_at: string;
  updated_at: string;
  activities: Activity[];
}

const STAGE_LABELS: Record<Stage, string> = {
  approach: 'アプローチ',
  meeting: '商談中',
  proposal: '提案',
  negotiation: '交渉',
  won: '契約済',
  lost: '失注',
};

const ACTIVITY_LABELS: Record<ActivityType, string> = {
  call: '電話',
  email: 'メール',
  meeting: '訪問・商談',
  note: 'メモ',
  stage_change: 'ステージ変更',
};

const ACTIVITY_ICONS: Record<ActivityType, string> = {
  call: '📞',
  email: '📧',
  meeting: '🤝',
  note: '📝',
  stage_change: '➡️',
};

const ALL_STAGES: Stage[] = ['approach', 'meeting', 'proposal', 'negotiation', 'won', 'lost'];

type PageProps = { params: Promise<{ id: string }> };

export default function LeadDetailPage(props: PageProps) {
  const params = use(props.params);
  const router = useRouter();
  const [lead, setLead] = useState<Lead | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 活動記録フォーム
  const [activityType, setActivityType] = useState<ActivityType>('note');
  const [activitySummary, setActivitySummary] = useState('');
  const [activityNextAction, setActivityNextAction] = useState('');
  const [isAddingActivity, setIsAddingActivity] = useState(false);

  // ステージ変更
  const [isChangingStage, setIsChangingStage] = useState(false);

  /** リードを読み、結果の種類を返す (409 のあとの読み直しで、結果に合わせて文を決めるため。#1917) */
  const fetchLead = useCallback(async (): Promise<LeadLoadOutcome> => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/sales/leads/${params.id}`);
      if (res.status === 401) { router.push('/login'); return 'unauthorized'; }
      if (res.status === 403) { setError('権限がありません'); return 'forbidden'; }
      if (res.status === 404) {
        // リードが消えていたら、前に読んだリードを画面に残さない (消えたリードのステージを変えられるように見せない。#1917)
        setLead(null);
        setError('リードが見つかりません');
        return 'not-found';
      }
      if (!res.ok) throw new Error('取得失敗');
      const json = await res.json();
      setLead(json.data);
      return 'loaded';
    } catch {
      setError('リードの取得に失敗しました');
      return 'failed';
    } finally {
      setIsLoading(false);
    }
  }, [params.id, router]);

  useEffect(() => { fetchLead(); }, [fetchLead]);

  const handleAddActivity = async () => {
    if (!activitySummary.trim()) return;
    setIsAddingActivity(true);
    try {
      const res = await fetch(`/api/admin/sales/leads/${params.id}/activities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity_type: activityType,
          details: {
            summary: activitySummary,
            next_action: activityNextAction || undefined,
            date: todayLocal(),
          },
        }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error?.message ?? '記録失敗');
      }
      setActivitySummary('');
      setActivityNextAction('');
      await fetchLead();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '活動記録の追加に失敗しました');
    } finally {
      setIsAddingActivity(false);
    }
  };

  const handleStageChange = async (newStage: Stage) => {
    if (!lead || lead.stage === newStage) return;
    setIsChangingStage(true);
    try {
      const res = await fetch(`/api/admin/sales/leads/${params.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: newStage }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        if (isStaleDataConflict(res.status, body)) {
          // 別の担当者が先にステージを変えていた (API は書かずに 409 CONFLICT_STALE_DATA を返す)。今のステージを読み直して、その旨を出す。
          // 文は読み直しの結果を待ってから決める (読み直せなかったのに「読み込み直した」と出さない。
          // 404 / 403 のときは fetchLead が出した理由の文を残す。#1917)
          const message = staleStageMessageOf(await fetchLead());
          if (message !== null) setError(message);
          return;
        }
        throw new Error('ステージ変更失敗');
      }
      await fetchLead();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'ステージ変更に失敗しました');
    } finally {
      setIsChangingStage(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500">読み込み中...</p>
      </div>
    );
  }

  if (error && !lead) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error}</p>
          <Link href="/admin/sales" className="text-blue-600 hover:underline">リード一覧に戻る</Link>
        </div>
      </div>
    );
  }

  if (!lead) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* ヘッダー */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Link href="/admin/sales" className="text-gray-500 hover:text-gray-700 text-sm">
              ← リード一覧
            </Link>
            <span className="text-gray-300">/</span>
            <h1 className="text-xl font-bold text-gray-900">{lead.company_name}</h1>
          </div>
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-blue-100 text-blue-700 font-medium">
            {STAGE_LABELS[lead.stage]}
          </span>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 左カラム: 基本情報 */}
          <div className="lg:col-span-1 space-y-4">
            {/* 基本情報 */}
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">基本情報</h2>
              <dl className="space-y-2.5 text-sm">
                {lead.industry && (
                  <div>
                    <dt className="text-gray-500">業種</dt>
                    <dd className="text-gray-900">{lead.industry}</dd>
                  </div>
                )}
                {lead.employee_count != null && (
                  <div>
                    <dt className="text-gray-500">従業員数</dt>
                    <dd className="text-gray-900">{lead.employee_count.toLocaleString()} 名</dd>
                  </div>
                )}
                {lead.contact_name && (
                  <div>
                    <dt className="text-gray-500">担当者</dt>
                    <dd className="text-gray-900">{lead.contact_name}</dd>
                  </div>
                )}
                {lead.contact_email && (
                  <div>
                    <dt className="text-gray-500">メール</dt>
                    <dd className="text-gray-900 break-all">{lead.contact_email}</dd>
                  </div>
                )}
                {lead.contact_phone && (
                  <div>
                    <dt className="text-gray-500">電話</dt>
                    <dd className="text-gray-900">{lead.contact_phone}</dd>
                  </div>
                )}
                {lead.source && (
                  <div>
                    <dt className="text-gray-500">流入経路</dt>
                    <dd className="text-gray-900">{lead.source}</dd>
                  </div>
                )}
                {lead.estimated_acv != null && (
                  <div>
                    <dt className="text-gray-500">推定 ACV</dt>
                    <dd className="text-gray-900 font-semibold">¥{lead.estimated_acv.toLocaleString()}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-gray-500">登録日</dt>
                  <dd className="text-gray-900">{new Date(lead.created_at).toLocaleDateString('ja-JP')}</dd>
                </div>
              </dl>
            </div>

            {/* ステージ変更 */}
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">ステージ変更</h2>
              <div className="flex flex-col gap-2">
                {ALL_STAGES.map((stage) => (
                  <button
                    key={stage}
                    onClick={() => handleStageChange(stage)}
                    disabled={isChangingStage || lead.stage === stage}
                    className={`w-full text-left px-3 py-1.5 text-xs rounded border transition-colors ${
                      lead.stage === stage
                        ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                        : 'border-gray-200 hover:bg-gray-50 text-gray-600'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {STAGE_LABELS[stage]}
                  </button>
                ))}
              </div>
            </div>

            {/* メモ */}
            {lead.notes && (
              <div className="bg-white rounded-lg shadow p-4">
                <h2 className="text-sm font-semibold text-gray-700 mb-2">メモ</h2>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{lead.notes}</p>
              </div>
            )}
          </div>

          {/* 右カラム: 活動履歴 */}
          <div className="lg:col-span-2 space-y-4">
            {/* 活動記録フォーム */}
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">活動を記録</h2>
              <div className="flex gap-2 mb-3 flex-wrap">
                {(['call', 'email', 'meeting', 'note'] as ActivityType[]).map((type) => (
                  <button
                    key={type}
                    onClick={() => setActivityType(type)}
                    className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                      activityType === type
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    {ACTIVITY_ICONS[type]} {ACTIVITY_LABELS[type]}
                  </button>
                ))}
              </div>
              <textarea
                value={activitySummary}
                onChange={(e) => setActivitySummary(e.target.value)}
                rows={3}
                placeholder={`${ACTIVITY_LABELS[activityType]}の内容を入力...`}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y mb-2"
              />
              <input
                type="text"
                value={activityNextAction}
                onChange={(e) => setActivityNextAction(e.target.value)}
                placeholder="次のアクション (任意)"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
              />
              <div className="flex justify-end">
                <button
                  onClick={handleAddActivity}
                  disabled={isAddingActivity || !activitySummary.trim()}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isAddingActivity ? '記録中...' : '活動を記録'}
                </button>
              </div>
            </div>

            {/* 活動履歴一覧 */}
            <div className="bg-white rounded-lg shadow">
              <div className="px-4 py-3 border-b border-gray-100">
                <h2 className="text-sm font-semibold text-gray-700">活動履歴</h2>
              </div>
              <div className="divide-y divide-gray-50">
                {lead.activities.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">活動履歴はありません</p>
                ) : (
                  lead.activities.map((activity) => (
                    <div key={activity.id} className="px-4 py-3">
                      <div className="flex items-start gap-3">
                        <span className="text-lg flex-shrink-0 mt-0.5">
                          {ACTIVITY_ICONS[activity.activity_type]}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium text-gray-500">
                              {ACTIVITY_LABELS[activity.activity_type]}
                            </span>
                            <span className="text-xs text-gray-400">
                              {new Date(activity.created_at).toLocaleString('ja-JP')}
                            </span>
                          </div>
                          {activity.activity_type === 'stage_change' ? (
                            <p className="text-sm text-gray-700">
                              {STAGE_LABELS[(activity.details.from_stage as Stage)] ?? activity.details.from_stage as string}
                              {' → '}
                              {STAGE_LABELS[(activity.details.to_stage as Stage)] ?? activity.details.to_stage as string}
                            </p>
                          ) : (
                            <>
                              {activity.details.summary && (
                                <p className="text-sm text-gray-800 whitespace-pre-wrap">
                                  {activity.details.summary as string}
                                </p>
                              )}
                              {activity.details.next_action && (
                                <p className="text-xs text-blue-600 mt-1">
                                  次のアクション: {activity.details.next_action as string}
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
