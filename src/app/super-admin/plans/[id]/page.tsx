"use client";

/**
 * /super-admin/plans/[id] — プラン詳細・編集
 * operator/03-ui-spec.md §24 準拠
 *
 * 保存・公開・非公開・廃止・廃止の取り消しが 409 CONFLICT_STALE_DATA (読んでから書くまでに別の運営が先にプランを変えた) で
 * 断られたら、画面が自分でプランを読み直し、読み直した旨を画面の上に出す (運営が手で読み込み直さなくてよいように。#1917)。
 * 表示名・説明・表示順の入力欄は、最後に読んだ・保存した値から変えている (書きかけ) ものだけ残し、ほかは読み直した値にする。
 * 保存・状態の変更に成功したあとの読み直しも同じく書きかけの欄を残す (応答を待つあいだ・読み直しを待つあいだに打った、
 * まだ送っていない入力を黙って消さない。保存のあとは、送った欄の比べる元を送った値にしてから読み直す)。
 * ただし読み直したプランが編集できない状態 (廃止) なら、どの読み直しでも書きかけを残さず、全部を読み直した値にする
 * (廃止のあとは入力欄が編集できず保存のボタンも出ないので、残すと送る道の無い値を、廃止済みのプランの値として見せ続ける)。
 * 一度表示したあとの読み直し (保存・状態の変更のあと・409 のあと) は画面を外さずに行い、失敗しても画面と入力欄を残して、
 * 文と「再試行」を出す (読み直しの失敗で画面ごとエラーに置き換えない。#1917)。読み直しが 404 / 403 で断られたときは、
 * 読み込み直しても変わらないので、その理由の文を出し、「再試行」は出さない。
 * 保存は、表示名・説明・表示順のうち最後に読んだ・保存した値から変えた欄だけを送る (手を付けていない欄を、画面を開いたあとに
 * 別の運営が変えた値の上に古い値で書かない。#1917)。保存に成功したら、送った欄の値をそのまま新しい初めの値にする
 * (続く読み直しが失敗しても、保存済みの欄を次の保存で送り直さない・「再試行」で書きかけとして残さない。#1917)。
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { forbiddenMessageForScreen, isStaleDataConflict } from '@/lib/admin/api-error-message';
import { ORG_SUBSCRIPTION_PLAN_ROW_NOTE, countsOrganizationsFor } from '@/lib/super-admin/plan-subscribers';

type Plan = {
  id: string;
  plan_key: string;
  display_name: string;
  plan_type: string;
  description: string | null;
  monthly_price_jpy: number | null;
  yearly_price_jpy: number | null;
  max_members: number | null;
  stripe_product_id: string | null;
  /** 月額の Stripe Price ID */
  stripe_price_id: string | null;
  /** 年額の Stripe Price ID (#1102) */
  stripe_yearly_price_id: string | null;
  status: string;
  display_order: number;
  trial_days: number;
  feature_packages: string[];
  price_history: PriceHistoryEntry[];
};

type PriceHistoryEntry = {
  id: string;
  old_monthly_price_jpy: number | null;
  new_monthly_price_jpy: number | null;
  reason: string | null;
  applies_to: string;
  changed_by: string;
  created_at: string;
};

/** 入力欄 (表示名・説明・表示順) の値 */
type PlanEdits = {
  displayName: string;
  description: string;
  displayOrder: number;
};

/** プランの行から作る入力欄の初めの値 */
function editsOf(plan: Plan): PlanEdits {
  return { displayName: plan.display_name, description: plan.description ?? '', displayOrder: plan.display_order };
}

/** 入力欄が書きかけか (最後に読んだ・保存した初めの値から、どれかの欄を変えている) */
function isEdited(current: PlanEdits, loaded: PlanEdits): boolean {
  return Object.keys(changedPlanFields(current, loaded)).length > 0;
}

/** 保存で送る本文 (PATCH /api/super-admin/plans/{id} の表示名・説明・表示順) */
type PlanSaveBody = {
  display_name?: string;
  description?: string | null;
  display_order?: number;
};

/**
 * 保存で送る本文。最後に読んだ・保存した初めの値から変えた欄だけを入れる。
 * 手を付けていない欄を送ると、画面を開いたあとに別の運営が変えたその欄を、開いたときの古い値で上書きしてしまう
 * (route は送られた項目をそのまま書き、読んだ値を条件にするのは status だけ。#1917)。説明の空欄は null にする (これまでと同じ)
 */
function changedPlanFields(current: PlanEdits, loaded: PlanEdits): PlanSaveBody {
  const body: PlanSaveBody = {};
  if (current.displayName !== loaded.displayName) body.display_name = current.displayName;
  if (current.description !== loaded.description) body.description = current.description || null;
  if (current.displayOrder !== loaded.displayOrder) body.display_order = current.displayOrder;
  return body;
}

/**
 * 保存に成功したあとの新しい初めの値。送った欄 (body にある欄) は送った値 (sent) に、送らなかった欄は保存の前の
 * 初めの値 (loaded) のままにする。保存の応答の行は使わない (#1724: plan は GET からだけ作る)。
 * 続く読み直しが失敗したとき、保存済みの欄が書きかけに見えて次の保存で送り直され、そのあいだに別の運営が変えた値を
 * 古い値で上書きするのを防ぐ (#1917)。説明は送るとき空欄を null にするが、初めの値は入力欄の形 ('') のまま比べる
 */
function editsAfterSave(loaded: PlanEdits, sent: PlanEdits, body: PlanSaveBody): PlanEdits {
  return {
    displayName: body.display_name !== undefined ? sent.displayName : loaded.displayName,
    description: body.description !== undefined ? sent.description : loaded.description,
    displayOrder: body.display_order !== undefined ? sent.displayOrder : loaded.displayOrder,
  };
}

/**
 * 画面の上に出す、読み直しについての文 (#1917)。
 *   - stale              : 409 CONFLICT_STALE_DATA のあとに読み直した
 *   - stale-reload-failed: 409 CONFLICT_STALE_DATA のあとの読み直しに失敗した (「再試行」を出す)
 *   - reload-failed      : 保存・状態の変更に成功したあとの読み直しに失敗した (「再試行」を出す)
 * editsKept は、入力欄の書きかけを読み直しで消さずに残したか。
 * unavailable の message は画面に出す理由の文。404 は PLAN_NOT_FOUND_ON_RELOAD_MESSAGE。
 * 403 は応答の本文の文が理由の文 (二段階認証の確認が要る など。#2014 の operatorForbiddenMessageOf) ならその文、
 * それ以外 (ロールが足りない・本文が読めない) は「権限がありません」(forbiddenMessageForScreen。読み込み直しても変わらないので
 * どちらも「再試行」は出さない。#1917)
 */
type ReloadNotice =
  | { kind: 'stale'; editsKept: boolean }
  | { kind: 'stale-reload-failed'; editsKept: boolean }
  | { kind: 'reload-failed' }
  | { kind: 'unavailable'; reason: PlanUnavailableReason; message: string };

/**
 * 表示したあとの読み直しが、読み込み直しても変わらない理由で断られた (「再試行」を出さない。#1917)。
 *   - not-found: 404 (読み直しの間にプランが消えた)
 *   - forbidden: 403 (読み直しの間に運営の権限が外れた・二段階認証の確認が要るようになった)
 */
type PlanUnavailableReason = 'not-found' | 'forbidden';

/**
 * 409 CONFLICT_STALE_DATA のあとに読み直したときの文。
 * サーバーの文は「画面を読み込み直して」と頼む文なので使わない (画面が自分で読み直すため)
 */
const STALE_PLAN_MESSAGE =
  '別の運営が先にこのプランを変えていました。最新の内容を読み込み直したので、状態を確かめてから、もう一度操作してください';

/** 409 CONFLICT_STALE_DATA のあとの読み直しに失敗したときの文 */
const STALE_PLAN_RELOAD_FAILED_MESSAGE =
  '別の運営が先にこのプランを変えていました。最新の内容を読み込み直せませんでした。「再試行」で読み込み直してから、もう一度操作してください';

/** 保存・状態の変更に成功したあとの読み直しに失敗したときの文 */
const PLAN_RELOAD_FAILED_MESSAGE = '最新の内容を読み込めませんでした。「再試行」で読み込み直してください';

/** 読み直しが 404 (プランが消えた) で断られたときの文。読み込み直しても変わらないので「再試行」は出さない */
const PLAN_NOT_FOUND_ON_RELOAD_MESSAGE = 'プランが見つかりません。一覧に戻って確かめてください';

/** 保存を押したが、どの入力欄も最後に読んだ・保存した値から変えていなかったときの文 (送らない。#1917) */
const NO_PLAN_CHANGES_MESSAGE = '変更した項目がないので、保存していません';

/** 入力欄の書きかけを残したときに添える文 */
const EDITS_KEPT_SUFFIX = '（入力中の表示名・説明・表示順はそのまま残しています）';

function reloadNoticeText(notice: ReloadNotice): string {
  switch (notice.kind) {
    case 'stale':
      return `${STALE_PLAN_MESSAGE}${notice.editsKept ? EDITS_KEPT_SUFFIX : ''}`;
    case 'stale-reload-failed':
      return `${STALE_PLAN_RELOAD_FAILED_MESSAGE}${notice.editsKept ? EDITS_KEPT_SUFFIX : ''}`;
    case 'reload-failed':
      return PLAN_RELOAD_FAILED_MESSAGE;
    case 'unavailable':
      return notice.message;
  }
}

/**
 * 読み直しの結果。superseded は、読み直しの最中に新しい読み直しが始まったので結果を捨てた。
 * unavailable は、表示したあとの読み直しが 404 / 403 で断られた (読み込み直しても変わらない理由。#1917)
 */
type PlanReloadOutcome =
  | { kind: 'loaded'; editsKept: boolean }
  | { kind: 'failed' }
  | { kind: 'unavailable'; reason: PlanUnavailableReason; message: string }
  | { kind: 'superseded' };

/** 表示したあとの読み直しの HTTP ステータスのうち、読み込み直しても変わらない理由 (#1917) */
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

/**
 * 表示名・説明・表示順を編集できる状態か (下書き・公開中・非公開)。廃止したプランは編集できない
 * (route も廃止中は状態の変更のほかを断る)。入力欄の disabled と保存のボタン、読み直しで書きかけを残すかの判定に使う
 */
function isEditableStatus(status: string): boolean {
  return status === 'draft' || status === 'public' || status === 'private';
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft: { label: '下書き', color: 'bg-slate-100 text-slate-600' },
  public: { label: '公開中', color: 'bg-green-100 text-green-700' },
  private: { label: '非公開', color: 'bg-yellow-100 text-yellow-700' },
  deprecated: { label: '廃止', color: 'bg-red-100 text-red-700' },
};

export default function PlanDetailPage() {
  const params = useParams();
  const planId = params.id as string;

  const [plan, setPlan] = useState<Plan | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  // 保存を押したが送らなかったときの文 (変えた欄が無い。#1917)
  const [saveInfo, setSaveInfo] = useState('');

  // 編集フィールド
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [displayOrder, setDisplayOrder] = useState(0);
  const [activeTab, setActiveTab] = useState<'basic' | 'price' | 'history'>('basic');

  // 画面の上に出す、読み直しについての文 (#1917)
  const [reloadNotice, setReloadNotice] = useState<ReloadNotice | null>(null);
  const [isReloading, setIsReloading] = useState(false);
  // 一度プランを表示したか (表示したあとの読み直しは、画面を外さずに行う。#1917)
  const hasLoadedRef = useRef(false);
  // 入力欄のいまの値 (描画を待たずに読むための写し。入力欄は setEdits でだけ変える)
  const editsRef = useRef<PlanEdits>({ displayName: '', description: '', displayOrder: 0 });
  // 入力欄の初めの値。最後に読んだプランから作り、保存に成功したら送った欄を送った値にする
  // (読み直しのとき書きかけの欄を見分け、保存のとき変えた欄だけを送る。#1917)
  const loadedEditsRef = useRef<PlanEdits>({ displayName: '', description: '', displayOrder: 0 });
  // 読み直しを重ねたとき、古い読み直しの結果で上書きしないための連番
  const fetchSeq = useRef(0);

  const setEdits = useCallback((patch: Partial<PlanEdits>) => {
    const next = { ...editsRef.current, ...patch };
    editsRef.current = next;
    setDisplayName(next.displayName);
    setDescription(next.description);
    setDisplayOrder(next.displayOrder);
    // 入力欄が変わったら、「変更した項目がないので、保存していません」は古いので消す
    setSaveInfo('');
  }, []);

  /**
   * プランを読む。初めの読み込みは画面を「読み込み中」にし、失敗したら画面をエラーにする。
   * 表示したあとの読み直しは画面を外さず、失敗しても画面と入力欄を残す (結果は戻り値で返し、文は呼び出し側が決める。#1917)。
   * keepEdits のときは、入力欄のうち最後に読んだ・保存した値から変えている (書きかけの) 欄を残し、ほかは読んだ値にする。
   * ただし読んだプランが編集できない状態 (廃止) なら keepEdits でも全部を読んだ値にする (入力欄は編集できず保存のボタンも
   * 出ないので、書きかけを残すと、送る道の無い保存していない値を、廃止済みのプランの値として DB と食い違えて見せ続ける)
   */
  const fetchPlan = useCallback(async (options: { keepEdits?: boolean } = {}): Promise<PlanReloadOutcome> => {
    const seq = ++fetchSeq.current;
    const isReload = hasLoadedRef.current;
    if (isReload) {
      setIsReloading(true);
    } else {
      setIsLoading(true);
    }
    try {
      const res = await fetch(`/api/super-admin/plans/${planId}`);
      // 403 の本文が JSON として読めなくても「権限がありません」を出せるよう、読めない本文は null にする (#1917)
      const body: unknown = await res.json().catch(() => null);
      if (seq !== fetchSeq.current) return { kind: 'superseded' };
      const data = (body ?? {}) as { data?: Plan; error?: { message: string } };
      if (!res.ok || !data.data) {
        if (!isReload) setError(data.error?.message ?? 'プランの取得に失敗しました');
        // 表示したあとの読み直しが 404 / 403 なら、その理由を返す (「読み込み直せませんでした。再試行で…」で覆わない。#1917)。
        // 403 は本文の文 (二段階認証の確認が要る など) を捨てずに出す (#2014 の route の文を、読み直しのときにも打ち消さない)
        if (isReload && res.status === HTTP_NOT_FOUND) {
          return { kind: 'unavailable', reason: 'not-found', message: PLAN_NOT_FOUND_ON_RELOAD_MESSAGE };
        }
        if (isReload && res.status === HTTP_FORBIDDEN) {
          return { kind: 'unavailable', reason: 'forbidden', message: forbiddenMessageForScreen(body) };
        }
        return { kind: 'failed' };
      }
      const loaded = data.data;
      const fresh = editsOf(loaded);
      const previous = loadedEditsRef.current;
      const current = editsRef.current;
      const keep = options.keepEdits === true && isReload && isEditableStatus(loaded.status);
      const next: PlanEdits = {
        displayName: keep && current.displayName !== previous.displayName ? current.displayName : fresh.displayName,
        description: keep && current.description !== previous.description ? current.description : fresh.description,
        displayOrder: keep && current.displayOrder !== previous.displayOrder ? current.displayOrder : fresh.displayOrder,
      };
      const editsKept =
        next.displayName !== fresh.displayName ||
        next.description !== fresh.description ||
        next.displayOrder !== fresh.displayOrder;
      loadedEditsRef.current = fresh;
      hasLoadedRef.current = true;
      setPlan(loaded);
      setError('');
      setEdits(next);
      return { kind: 'loaded', editsKept };
    } catch {
      if (seq !== fetchSeq.current) return { kind: 'superseded' };
      if (!isReload) setError('ネットワークエラー');
      return { kind: 'failed' };
    } finally {
      if (seq === fetchSeq.current) {
        setIsLoading(false);
        setIsReloading(false);
      }
    }
  }, [planId, setEdits]);

  useEffect(() => {
    void fetchPlan();
  }, [fetchPlan]);

  /**
   * 保存・状態の変更に成功したあとの読み直し。失敗したら画面を残して文と「再試行」を出す (#1917)。
   * 書きかけの入力欄は残す (keepEdits)。保存の応答を待つあいだ・この読み直しを待つあいだに打った、まだ送っていない入力を
   * 読み直した値で黙って消さない。保存のあとは、呼ぶ前に送った欄の比べる元を送った値にしている (handleSave の editsAfterSave)
   * ので、送った値のままの欄は読み直した値になり、送ったあとに変えた欄だけが残る。
   * 読み直したプランが廃止 (自分の「廃止する」・待つあいだに別の運営が廃止) なら、書きかけも残さず読み直した値にする (fetchPlan)
   */
  const reloadAfterSuccess = useCallback(async () => {
    const outcome = await fetchPlan({ keepEdits: true });
    if (outcome.kind === 'failed') setReloadNotice({ kind: 'reload-failed' });
    if (outcome.kind === 'unavailable') setReloadNotice({ kind: 'unavailable', reason: outcome.reason, message: outcome.message });
  }, [fetchPlan]);

  /**
   * 409 CONFLICT_STALE_DATA (別の運営が先にプランを変えた) のあとの読み直し。書きかけの入力欄は残し
   * (読み直したプランが廃止なら残さない。そのときは「残しています」も添えない)、
   * 結果に合わせて文を出す (読み直せなかったのに「読み込み直した」と出さない。#1917)
   */
  const reloadAfterStale = useCallback(async () => {
    const editedBefore = isEdited(editsRef.current, loadedEditsRef.current);
    const outcome = await fetchPlan({ keepEdits: true });
    if (outcome.kind === 'loaded') {
      setReloadNotice({ kind: 'stale', editsKept: outcome.editsKept });
    } else if (outcome.kind === 'failed') {
      setReloadNotice({ kind: 'stale-reload-failed', editsKept: editedBefore });
    } else if (outcome.kind === 'unavailable') {
      // プランが消えた・権限が外れた: その理由を出す (「再試行」で読み込み直すよう促さない。#1917)
      setReloadNotice({ kind: 'unavailable', reason: outcome.reason, message: outcome.message });
    }
  }, [fetchPlan]);

  /** 「再試行」: 失敗した読み直しをやり直す。409 のあとの読み直しなら、成功したら 409 のあとの文にする */
  const retryReload = useCallback(async () => {
    if (reloadNotice?.kind === 'stale-reload-failed') {
      await reloadAfterStale();
      return;
    }
    const outcome = await fetchPlan({ keepEdits: true });
    if (outcome.kind === 'loaded') setReloadNotice(null);
    if (outcome.kind === 'unavailable') setReloadNotice({ kind: 'unavailable', reason: outcome.reason, message: outcome.message });
  }, [fetchPlan, reloadAfterStale, reloadNotice]);

  /**
   * 状態の変更 (公開・非公開・廃止・廃止の取り消し) の応答を処理する。成功なら読み直す。
   * 409 CONFLICT_STALE_DATA なら読み直して画面の上に文を出す (#1917)。それ以外の失敗は API の文を alert で出す
   */
  const handleStatusResponse = async (res: Response, failureSummary: string) => {
    if (res.ok) {
      await reloadAfterSuccess();
      return;
    }
    const data: unknown = await res.json().catch(() => null);
    if (isStaleDataConflict(res.status, data)) {
      await reloadAfterStale();
      return;
    }
    const message =
      typeof data === 'object' && data !== null ? (data as { error?: { message?: unknown } }).error?.message : undefined;
    alert(typeof message === 'string' ? message : `${failureSummary} (HTTP ${res.status})`);
  };

  const handleSave = async () => {
    setSaveError('');
    setSaveSuccess(false);
    setSaveInfo('');
    // 送るのは、最後に読んだ・保存した値から変えた欄だけ (手を付けていない欄を古い値で上書きしない。#1917)。
    // 送った値は写しておく (応答を待つあいだに入力欄が変わっても、保存済みの値として記録するのは送った値)
    const sent = editsRef.current;
    const changes = changedPlanFields(sent, loadedEditsRef.current);
    if (Object.keys(changes).length === 0) {
      setSaveInfo(NO_PLAN_CHANGES_MESSAGE);
      return;
    }
    setIsSaving(true);
    setReloadNotice(null);
    try {
      const res = await fetch(`/api/super-admin/plans/${planId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // #1728: 送るのは、この画面に入力欄がある項目 (表示名・説明・表示順) だけにする。
        // 以前は入力欄の無い banner_url を、いつも空文字で始まる状態から `null` にして送っていたため、
        // 保存のたびに subscription_plans.banner_url が null で上書きされていた。
        // PATCH の route は送られなかった項目を更新しない (`!== undefined` のときだけ updateData に入れる) ので、
        // 送らなければ banner_url はそのまま残る。
        // #1917: 入力欄のある 3 項目も、最後に読んだ・保存した値から変えた欄だけを送る (changedPlanFields)
        body: JSON.stringify(changes),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        if (isStaleDataConflict(res.status, data)) {
          // 別の運営が先にプランを変えていた (API は書いていない)。プランを読み直し、その旨を画面の上に出す。
          // 入力欄の書きかけは消さない (#1917)
          await reloadAfterStale();
          return;
        }
        const message =
          typeof data === 'object' && data !== null ? (data as { error?: { message?: unknown } }).error?.message : undefined;
        setSaveError(typeof message === 'string' ? message : '保存に失敗しました');
        return;
      }
      // 送った欄は保存済みなので、送った値を新しい初めの値にする。続く読み直しが失敗しても、次の保存でこの欄を
      // 送り直さず (そのあいだに別の運営が変えた値を古い値で上書きしない)、「再試行」で書きかけとして残さない (#1917)
      loadedEditsRef.current = editsAfterSave(loadedEditsRef.current, sent, changes);
      setSaveSuccess(true);
      // #1724: PATCH の応答はプランの行だけで、価格変更の履歴 (price_history) を含まない。
      // 応答で plan を丸ごと置き換えると履歴の一覧が空になるので、画面の状態は GET (fetchPlan) だけから作る
      // (公開・非公開・廃止の操作と同じ)。
      await reloadAfterSuccess();
    } catch {
      setSaveError('ネットワークエラー');
    } finally {
      setIsSaving(false);
    }
  };

  const handleStatusChange = async (newStatus: 'public' | 'private') => {
    const confirm = window.confirm(
      newStatus === 'public' ? 'このプランを公開しますか？' : 'このプランを非公開にしますか？'
    );
    if (!confirm) return;

    setReloadNotice(null);
    try {
      const res = await fetch(`/api/super-admin/plans/${planId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      // #1041 修正: 失敗時 (422/400/403 等) に無反応にせず、必ずエラーを表示する
      await handleStatusResponse(res, 'ステータス変更に失敗しました');
    } catch {
      alert('ステータス変更に失敗しました (ネットワークエラー)');
    }
  };

  // #1041 修正: public/private --> deprecated への廃止移行を許可 (以前は恒久ロックされていた)
  const handleDeprecate = async () => {
    const endsAtInput = window.prompt('廃止予定日 (YYYY-MM-DD) を入力してください');
    if (!endsAtInput) return;
    const endsAtDate = new Date(`${endsAtInput}T00:00:00.000Z`);
    if (Number.isNaN(endsAtDate.getTime())) {
      alert('日付の形式が不正です (例: 2026-12-31)');
      return;
    }
    // #1912: 組織のプランの行 (org_*) では組織の件数を数えない。確認の文に注記を添える (件数は出さない)
    const orgRowNote = plan && !countsOrganizationsFor(plan) ? `\n\n${ORG_SUBSCRIPTION_PLAN_ROW_NOTE}` : '';
    if (!window.confirm(`このプランを ${endsAtInput} 廃止予定で廃止しますか？${orgRowNote}`)) return;

    setReloadNotice(null);
    try {
      const res = await fetch(`/api/super-admin/plans/${planId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'deprecated', ends_at: endsAtDate.toISOString() }),
      });
      await handleStatusResponse(res, '廃止処理に失敗しました');
    } catch {
      alert('廃止処理に失敗しました (ネットワークエラー)');
    }
  };

  // deprecated --> private への緊急ロールバック (public には戻さない)
  const handleUndeprecate = async () => {
    if (!window.confirm('廃止を取り消し、非公開状態に戻しますか？')) return;
    setReloadNotice(null);
    try {
      const res = await fetch(`/api/super-admin/plans/${planId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'private' }),
      });
      await handleStatusResponse(res, '廃止取り消しに失敗しました');
    } catch {
      alert('廃止取り消しに失敗しました (ネットワークエラー)');
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-48 text-slate-400">読み込み中...</div>;
  }

  if (error || !plan) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
        {error || 'プランが見つかりません'}
      </div>
    );
  }

  const statusInfo = STATUS_LABELS[plan.status] ?? { label: plan.status, color: 'bg-slate-100 text-slate-600' };
  const isEditable = isEditableStatus(plan.status);
  // #1912: 組織のプランの行 (org_*) は組織の段階とは無関係で、組織の件数を数えない。廃止・価格変更の前に注記を出す
  const showOrgRowNote = !countsOrganizationsFor(plan);

  return (
    <div className="max-w-3xl mx-auto">
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/super-admin/plans" className="text-slate-400 hover:text-slate-600 transition-colors text-sm">
            ← 一覧
          </Link>
          <span className="text-slate-300">/</span>
          <h1 className="text-xl font-bold text-slate-900">{plan.display_name}</h1>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
            {statusInfo.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {plan.status === 'draft' && (
            <button
              onClick={() => handleStatusChange('public')}
              className="px-3 py-1.5 bg-green-500 text-white rounded-lg text-xs font-medium hover:bg-green-600 transition-colors"
            >
              公開する
            </button>
          )}
          {plan.status === 'public' && (
            <button
              onClick={() => handleStatusChange('private')}
              className="px-3 py-1.5 bg-yellow-500 text-white rounded-lg text-xs font-medium hover:bg-yellow-600 transition-colors"
            >
              非公開にする
            </button>
          )}
          {plan.status === 'private' && (
            <button
              onClick={() => handleStatusChange('public')}
              className="px-3 py-1.5 bg-green-500 text-white rounded-lg text-xs font-medium hover:bg-green-600 transition-colors"
            >
              再公開する
            </button>
          )}
          {(plan.status === 'public' || plan.status === 'private') && (
            <Link
              href={`/super-admin/plans/${plan.id}/price-change`}
              className="px-3 py-1.5 bg-orange-500 text-white rounded-lg text-xs font-medium hover:bg-orange-600 transition-colors"
            >
              価格変更
            </Link>
          )}
          {(plan.status === 'public' || plan.status === 'private') && (
            <button
              onClick={handleDeprecate}
              className="px-3 py-1.5 bg-red-500 text-white rounded-lg text-xs font-medium hover:bg-red-600 transition-colors"
            >
              廃止する
            </button>
          )}
          {plan.status === 'deprecated' && (
            <button
              onClick={handleUndeprecate}
              className="px-3 py-1.5 bg-slate-500 text-white rounded-lg text-xs font-medium hover:bg-slate-600 transition-colors"
            >
              廃止を取り消す
            </button>
          )}
        </div>
      </div>

      {reloadNotice && (
        <div
          role="alert"
          data-testid="plan-reload-notice"
          className="mb-4 bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm flex items-center justify-between gap-4"
        >
          <span>{reloadNoticeText(reloadNotice)}</span>
          {(reloadNotice.kind === 'stale-reload-failed' || reloadNotice.kind === 'reload-failed') && (
            <button
              type="button"
              onClick={() => void retryReload()}
              disabled={isReloading}
              className="shrink-0 underline whitespace-nowrap hover:text-amber-900 disabled:opacity-50"
            >
              {isReloading ? '読み込み中...' : '再試行'}
            </button>
          )}
        </div>
      )}

      {showOrgRowNote && (
        <p
          data-testid="org-subscription-plan-row-note"
          className="mb-4 bg-slate-50 border border-slate-200 text-slate-600 px-4 py-3 rounded-lg text-xs"
        >
          {ORG_SUBSCRIPTION_PLAN_ROW_NOTE}
        </p>
      )}

      {/* タブ */}
      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {(['basic', 'price', 'history'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-orange-500 text-orange-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab === 'basic' ? '基本情報' : tab === 'price' ? '価格設定' : '価格変更履歴'}
          </button>
        ))}
      </div>

      {/* 基本情報タブ */}
      {activeTab === 'basic' && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">plan_key</label>
              <code className="font-mono text-sm bg-slate-100 px-2 py-1 rounded">{plan.plan_key}</code>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">種別</label>
              <span className="text-sm text-slate-700">{plan.plan_type}</span>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">表示名 *</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setEdits({ displayName: e.target.value })}
              disabled={!isEditable}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-slate-50"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">説明</label>
            <textarea
              value={description}
              onChange={(e) => setEdits({ description: e.target.value })}
              disabled={!isEditable}
              rows={4}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-slate-50"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">表示順</label>
            <input
              type="number"
              value={displayOrder}
              onChange={(e) => setEdits({ displayOrder: Number(e.target.value) })}
              disabled={!isEditable}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-slate-50"
            />
          </div>

          <div className="flex items-center gap-4 pt-2">
            <div className="text-sm text-slate-500">最大メンバー: {plan.max_members ?? '無制限'}</div>
            <div className="text-sm text-slate-500">試用期間: {plan.trial_days} 日</div>
          </div>

          {saveError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {saveError}
            </div>
          )}
          {saveInfo && (
            <div
              data-testid="plan-save-info"
              className="bg-slate-50 border border-slate-200 text-slate-600 px-4 py-3 rounded-lg text-sm"
            >
              {saveInfo}
            </div>
          )}
          {saveSuccess && (
            <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
              保存しました
            </div>
          )}

          {isEditable && (
            <div className="flex justify-end pt-2">
              <button
                onClick={handleSave}
                // 読み直しの最中は保存しない (読み直しが入力欄を今のプランの値に合わせる前の値を送らないため。#1917)
                disabled={isSaving || isReloading}
                className="px-5 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50"
              >
                {isSaving ? '保存中...' : '保存する'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* 価格設定タブ */}
      {activeTab === 'price' && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">月額</label>
              <p className="text-2xl font-bold text-slate-800">
                {plan.monthly_price_jpy != null ? `¥${plan.monthly_price_jpy.toLocaleString()}` : '—'}
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">年額</label>
              <p className="text-2xl font-bold text-slate-800">
                {plan.yearly_price_jpy != null ? `¥${plan.yearly_price_jpy.toLocaleString()}` : '—'}
              </p>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-100">
            <p className="text-xs font-medium text-slate-500 mb-2">Stripe 連携</p>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-slate-500">Product ID:</span>
                <code className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">
                  {plan.stripe_product_id ?? '未設定'}
                </code>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-500">Price ID (月額):</span>
                <code className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">
                  {plan.stripe_price_id ? `${plan.stripe_price_id.slice(0, 12)}...` : '未設定'}
                </code>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-500">Price ID (年額):</span>
                <code className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">
                  {plan.stripe_yearly_price_id ? `${plan.stripe_yearly_price_id.slice(0, 12)}...` : '未設定'}
                </code>
              </div>
            </div>
          </div>

          {(plan.status === 'public' || plan.status === 'private') && (
            <div className="pt-4">
              <Link
                href={`/super-admin/plans/${plan.id}/price-change`}
                className="inline-block px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors"
              >
                価格変更フローを開始
              </Link>
              <p className="text-xs text-slate-400 mt-2">
                価格変更は影響シミュレーション → 確認 → 実行の 3 ステップで行います
              </p>
            </div>
          )}
        </div>
      )}

      {/* 価格変更履歴タブ */}
      {activeTab === 'history' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-slate-600">変更日</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">旧月額</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">新月額</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">適用範囲</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">理由</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(plan.price_history ?? []).map((h) => (
                <tr key={h.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-600">
                    {new Date(h.created_at).toLocaleDateString('ja-JP')}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-500">
                    {h.old_monthly_price_jpy != null ? `¥${h.old_monthly_price_jpy.toLocaleString()}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-800">
                    {h.new_monthly_price_jpy != null ? `¥${h.new_monthly_price_jpy.toLocaleString()}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-xs">{h.applies_to}</td>
                  <td className="px-4 py-3 text-slate-500 text-xs truncate max-w-xs">{h.reason ?? '—'}</td>
                </tr>
              ))}
              {(plan.price_history ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                    価格変更履歴がありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
