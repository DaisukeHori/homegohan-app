'use client';

/**
 * リード詳細 + 活動履歴 + ステージ変更
 * operator/03-ui-spec.md §17 準拠
 * 権限: sales, admin, super_admin
 * 流入経路は src/lib/admin/sales-schemas.ts の表示名で出す (以前は英字の内部の値 cold_call などのまま。表に無い値はそのまま。#2112 Z3)
 */
import { useState, useEffect, useCallback, useRef, use } from 'react';
import {
  UNAUTHENTICATED_SCREEN_MESSAGE,
  forbiddenMessageForScreen,
  forbiddenMessageOfResponse,
  isStaleDataConflict,
} from '@/lib/admin/api-error-message';
import {
  AdminActionNoResponseError,
  AdminScreenError,
  adminActionErrorOfResponse,
  adminActionNoResponseMessage,
  displayableAdminError,
  sendAdminAction,
} from '@/lib/admin/admin-screen-messages';
import {
  adminCreateFoundGuide,
  adminCreateNoResponseMessage,
  adminCreateNotFoundGuide,
  adminCreateStoppedMessage,
  confirmCreatedRow,
} from '@/lib/admin/admin-create-no-response';
import { loginPathWithNext } from '@/lib/auth/signed-in-user';
import { todayLocal } from '@/lib/date-utils';
import Link from 'next/link';
import { leadSourceLabel } from '@/lib/admin/sales-schemas';
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

/** 403 (Forbidden) の HTTP ステータス */
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
/** ステージの変更の失敗の文。403 の本文が理由の文 (二段階認証の確認が要る など) ならそちらを出す (#1917) */
const STAGE_CHANGE_FAILURE_MESSAGE = 'ステージ変更失敗';
/** 活動の記録・ステージの変更の失敗の文の操作の名前 (「活動の記録に失敗しました (HTTP 502)」。#2086 V6) */
const ADD_ACTIVITY_ACTION = '活動の記録';
const STAGE_CHANGE_ACTION = 'ステージの変更';
/** 活動の記録の応答を受け取れなかったあとの読み直しの文の対象の名前 (「読み込み直したところ、活動は保存されていました」。#2101 X2) */
const ACTIVITY_SUBJECT = '活動';
/** リードの詳細の画面のパス (ログインのあとに戻る先。#2101 X2) */
const leadDetailPath = (leadId: string) => `/admin/sales/${leadId}`;

/**
 * リードの読み込み (fetchLead) の結果。
 *   - loaded      : 読めた
 *   - unauthorized: 401 (ログインの画面へ移した)
 *   - forbidden   : 403 (「権限がありません」か、応答の本文の理由の文 (二段階認証の確認が要る など) を出した)
 *   - not-found   : 404 (「リードが見つかりません」を出した)
 *   - failed      : そのほかの失敗 (「リードの取得に失敗しました」を出した)
 */
type LeadLoadOutcome = 'loaded' | 'unauthorized' | 'forbidden' | 'not-found' | 'failed';

/** リードの読み込みの結果 (読めたときは読んだリードを持つ。活動の記録の応答を受け取れなかったあとの読み直しで比べる。#2101 X2) */
type LeadLoadResult = { outcome: 'loaded'; lead: Lead } | { outcome: Exclude<LeadLoadOutcome, 'loaded'> };

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

/** 送った活動 (route は details をそのまま insert する。next_action は空なら送らない) */
interface SentActivity {
  readonly activityType: ActivityType;
  readonly summary: string;
  readonly nextAction: string | undefined;
  readonly date: string;
}

/**
 * 記録の応答を受け取れなかった (サーバーで済んだか分からない) 活動 (#2101 X2)。これがあるあいだは「活動を記録」を止める。
 *   - message: 止めているあいだに出す文 (adminCreateStoppedMessage)
 *   - retryable: 「確かめ直す」で読み直せば決まりうるか (読み直しの失敗が通信・サーバーの一時的なもの、
 *     読み直した活動履歴に送った活動がまだ無い (サーバーが書き込みの途中かもしれない))。401 / 403 (押しても必ず失敗する) は false
 */
interface UnconfirmedActivity {
  readonly sent: SentActivity;
  readonly knownIds: ReadonlySet<string>;
  readonly summary: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** 読み直した活動が、送った活動と同じ内容か (種類・本文・次のアクション・日付) */
function isSameActivity(activity: Activity, sent: SentActivity): boolean {
  return (
    activity.activity_type === sent.activityType &&
    activity.details.summary === sent.summary &&
    activity.details.next_action === sent.nextAction &&
    activity.details.date === sent.date
  );
}

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
  // 活動の記録の応答を受け取れなかったあと、読み直しで記録できていたと確かめたときの文 (#2101 X2)
  const [activityNotice, setActivityNotice] = useState<string | null>(null);
  // 記録の応答を受け取れず、読み直しにも失敗した・読み直しでまだ見つからないので、記録できたか分からない活動 (#2101 X2)。
  // sales_lead_activities には一意の制約が無く、押し直すと活動が 2 行できるので、これがあるあいだは「活動を記録」を止める。
  // リードの読み直し (fetchLead) が error を消しても、この文は消えない (別の state)。ref は再描画の前に続けて押されたときの守り
  const [unconfirmedActivity, setUnconfirmedActivity] = useState<UnconfirmedActivity | null>(null);
  const unconfirmedActivityRef = useRef<UnconfirmedActivity | null>(null);
  const [isConfirmingActivity, setIsConfirmingActivity] = useState(false);

  // ステージ変更
  const [isChangingStage, setIsChangingStage] = useState(false);
  // 活動の記録かステージの変更のどちらかの書き込みとそのあとの読み直しの応答を待っているか (10/26 の整合ゲート 1026e。#2050)。
  // どちらの書き込みのあとの読み直しもリードを丸ごと差し替えるので、2 つを重ねると、先に送った読み直しの応答が後に届いたとき、
  // その古いリード (例: 変える前のステージ) で表示が上書きされる (#2053 のクーポン・機能パッケージと同じ型)。
  // 待つあいだは両方のボタンを止め、押されても送らない。ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り
  const writeInFlightRef = useRef(false);
  const isWriting = isAddingActivity || isChangingStage || isConfirmingActivity;

  /** リードを読み、結果の種類を返す (409 のあとの読み直しで、結果に合わせて文を決めるため。#1917) */
  const fetchLead = useCallback(async (): Promise<LeadLoadResult> => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/sales/leads/${params.id}`);
      // ログインのあとに、このリードへ戻れるよう next を付ける (#2101 X2。#2093 W4 と同じ)
      if (res.status === HTTP_UNAUTHORIZED) { router.push(loginPathWithNext(leadDetailPath(params.id))); return { outcome: 'unauthorized' }; }
      // 403 は本文の理由の文 (二段階認証の確認が要る など) を捨てずに出す。それ以外は「権限がありません」(#1917)
      if (res.status === HTTP_FORBIDDEN) { setError(await forbiddenMessageOfResponse(res)); return { outcome: 'forbidden' }; }
      if (res.status === 404) {
        // リードが消えていたら、前に読んだリードを画面に残さない (消えたリードのステージを変えられるように見せない。#1917)
        setLead(null);
        setError('リードが見つかりません');
        return { outcome: 'not-found' };
      }
      if (!res.ok) throw new Error('取得失敗');
      const json = await res.json();
      const loaded = (json as { data?: unknown } | null)?.data;
      // 活動履歴の無い形を読めたとは扱わない (読み直しで「記録されていない」と誤って決めない。#2101 X2)
      if (typeof loaded !== 'object' || loaded === null || !Array.isArray((loaded as { activities?: unknown }).activities)) {
        throw new Error('取得失敗');
      }
      setLead(loaded as Lead);
      return { outcome: 'loaded', lead: loaded as Lead };
    } catch {
      setError('リードの取得に失敗しました');
      return { outcome: 'failed' };
    } finally {
      setIsLoading(false);
    }
  }, [params.id, router]);

  useEffect(() => { fetchLead(); }, [fetchLead]);

  const markUnconfirmedActivity = (pending: UnconfirmedActivity | null) => {
    unconfirmedActivityRef.current = pending;
    setUnconfirmedActivity(pending);
  };

  /**
   * 活動の記録の応答を受け取れなかったあと、リードを読み直して送った活動ができていたかを確かめる (#2101 X2)。
   * できていれば済んだとして入力を空にし、「活動を記録」の止めを外す。
   * まだ無い (サーバーが書き込みの途中かもしれない)・読み直しにも失敗したときは、記録できたか分からないので「活動を記録」を止めたままにする
   * (押し直すと 2 行できうる。押し直すのは、活動履歴で確かめてから画面を開き直したときだけ。「確かめ直す」でこの関数をもう一度呼ぶ)
   */
  const confirmUnconfirmedActivity = async (pending: Omit<UnconfirmedActivity, 'message' | 'retryable'>) => {
    const result = await fetchLead();
    switch (result.outcome) {
      case 'loaded':
        break;
      case 'not-found':
        // リードが消えた (画面はリードが見つからない文を出す)。もう記録はできないので止めておく必要は無い
        markUnconfirmedActivity(null);
        return;
      case 'unauthorized':
      case 'forbidden':
        // ログインの画面へ移した / 権限が外れた (理由の文は fetchLead が出した)。読み直しても必ず失敗するので「確かめ直す」を出さない
        markUnconfirmedActivity({ ...pending, message: adminCreateStoppedMessage(pending.summary), retryable: false });
        return;
      case 'failed':
        markUnconfirmedActivity({ ...pending, message: adminCreateStoppedMessage(pending.summary), retryable: true });
        return;
    }
    const outcome = confirmCreatedRow(result.lead.activities, pending.knownIds, (activity) => isSameActivity(activity, pending.sent));
    if (outcome !== 'created') {
      // 送る前のリードは必ず読めている (knownIds がある) ので ambiguous にはならず、ここは not-found。
      // まだ無いことは記録されていないことの確かめにならない (サーバーが書き込みの途中なら、押し直すと 2 行になる)。止めたまま確かめ直させる
      markUnconfirmedActivity({
        ...pending,
        message: adminCreateStoppedMessage(pending.summary, adminCreateNotFoundGuide(ACTIVITY_SUBJECT)),
        retryable: true,
      });
      return;
    }
    // 済んでいた。入力欄が送った値のままなら空にする (待つあいだに書き足した文は消さない)
    markUnconfirmedActivity(null);
    setActivitySummary((current) => (current === pending.sent.summary ? '' : current));
    setActivityNextAction((current) => (current === (pending.sent.nextAction ?? '') ? '' : current));
    setActivityNotice(adminCreateNoResponseMessage(pending.summary, adminCreateFoundGuide(ACTIVITY_SUBJECT)));
  };

  const handleAddActivity = async () => {
    if (!lead || !activitySummary.trim() || writeInFlightRef.current || unconfirmedActivityRef.current !== null) return;
    writeInFlightRef.current = true;
    setIsAddingActivity(true);
    setActivityNotice(null);
    // 応答を受け取れなかったときに、読み直した活動履歴と比べるための、送る前の活動と送った内容 (#2101 X2)
    const knownIds: ReadonlySet<string> = new Set(lead.activities.map((activity) => activity.id));
    const sent: SentActivity = {
      activityType,
      summary: activitySummary,
      nextAction: activityNextAction || undefined,
      date: todayLocal(),
    };
    try {
      // 通信そのものの失敗は AdminActionNoResponseError (ブラウザの英字の例外の文を出さない。#2086 V6)
      const res = await sendAdminAction(
        `/api/admin/sales/leads/${params.id}/activities`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activity_type: sent.activityType,
            details: {
              summary: sent.summary,
              next_action: sent.nextAction,
              date: sent.date,
            },
          }),
        },
        ADD_ACTIVITY_ACTION,
      );
      if (!res.ok) {
        // 本文は JSON でないこともある (プロキシの 502 の HTML など) ので読み失敗で例外にしない (#2086 V6)。
        // 本文に API の文の無い 502 / 503 / 504 は応答を受け取れなかったもの (AdminActionNoResponseError。#2101 X2)
        throw await adminActionErrorOfResponse(res, ADD_ACTIVITY_ACTION);
      }
      // 入力が送った値のままなら空にする (記録の応答を待つあいだも入力欄は書き換えられるので、書き足した文は消さない。#2107 Y7 と同じ型)
      setActivitySummary((current) => (current === sent.summary ? '' : current));
      setActivityNextAction((current) => (current === (sent.nextAction ?? '') ? '' : current));
      await fetchLead();
    } catch (e: unknown) {
      if (e instanceof AdminActionNoResponseError) {
        // サーバーで記録が済んでから応答が切れたこともある。失敗と見せて押し直させず、リードを読み直して確かめる (#2101 X2)
        await confirmUnconfirmedActivity({ sent, knownIds, summary: e.message });
      } else {
        setError(displayableAdminError(e, '活動記録の追加に失敗しました'));
      }
    } finally {
      writeInFlightRef.current = false;
      setIsAddingActivity(false);
    }
  };

  /** 「確かめ直す」: 記録できたか分からない活動を、リードを読み直して確かめる (#2101 X2) */
  const handleRetryConfirmActivity = async () => {
    const pending = unconfirmedActivityRef.current;
    if (pending === null || !pending.retryable || writeInFlightRef.current) return;
    writeInFlightRef.current = true;
    setIsConfirmingActivity(true);
    try {
      await confirmUnconfirmedActivity(pending);
    } finally {
      writeInFlightRef.current = false;
      setIsConfirmingActivity(false);
    }
  };

  const handleStageChange = async (newStage: Stage) => {
    if (!lead || lead.stage === newStage || writeInFlightRef.current) return;
    writeInFlightRef.current = true;
    setIsChangingStage(true);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/admin/sales/leads/${params.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: newStage }),
        });
      } catch {
        // 通信そのものの失敗 (ブラウザの英字の例外の文を出さない。#2086 V6)
        throw new AdminScreenError(adminActionNoResponseMessage(STAGE_CHANGE_ACTION));
      }
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        if (isStaleDataConflict(res.status, body)) {
          // 別の担当者が先にステージを変えていた (API は書かずに 409 CONFLICT_STALE_DATA を返す)。今のステージを読み直して、その旨を出す。
          // 文は読み直しの結果を待ってから決める (読み直せなかったのに「読み込み直した」と出さない。
          // 404 / 403 のときは fetchLead が出した理由の文を残す。#1917)
          const message = staleStageMessageOf((await fetchLead()).outcome);
          if (message !== null) setError(message);
          return;
        }
        // 401 は「ステージ変更失敗」ではなく、運営の画面で揃えた「ログインし直してください」(#2112 Z4)
        if (res.status === HTTP_UNAUTHORIZED) throw new AdminScreenError(UNAUTHENTICATED_SCREEN_MESSAGE);
        // 403 は本文の理由の文 (二段階認証の確認が要る など) を捨てずに出す。それ以外の 403 と失敗は「ステージ変更失敗」(#1917)
        if (res.status === HTTP_FORBIDDEN) throw new AdminScreenError(forbiddenMessageForScreen(body, STAGE_CHANGE_FAILURE_MESSAGE));
        throw new AdminScreenError(STAGE_CHANGE_FAILURE_MESSAGE);
      }
      await fetchLead();
    } catch (e: unknown) {
      // 画面に出すのは日本語の文だけ (ブラウザの英字の例外の文などは出さない。#2086 V6)
      setError(displayableAdminError(e, 'ステージ変更に失敗しました'));
    } finally {
      writeInFlightRef.current = false;
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
                    <dd className="text-gray-900">{leadSourceLabel(lead.source)}</dd>
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
                    disabled={isWriting || lead.stage === stage}
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
              {activityNotice && (
                <p role="status" className="bg-green-50 border border-green-200 text-green-800 px-3 py-2 rounded mb-3 text-sm">
                  {activityNotice}
                </p>
              )}
              {unconfirmedActivity && (
                <div role="alert" className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-3 py-2 rounded mb-3 text-sm">
                  {unconfirmedActivity.message}
                </div>
              )}
              <div className="flex justify-end gap-2">
                {unconfirmedActivity?.retryable && (
                  <button
                    onClick={handleRetryConfirmActivity}
                    disabled={isWriting}
                    className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isConfirmingActivity ? '確認中...' : '確かめ直す'}
                  </button>
                )}
                <button
                  onClick={handleAddActivity}
                  disabled={isWriting || !activitySummary.trim() || unconfirmedActivity !== null}
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
