"use client";

/**
 * /super-admin/coupons/[id] — クーポン詳細・編集
 * operator/03-ui-spec.md §14 / operator/04-plan-management.md §4.1 準拠
 *
 * 状態の変更 (一時停止・再開) の通信そのものが失敗した (fetch が reject した) ときは、サーバーが変更を済ませてから応答が切れた
 * こともあるので、クーポンを読み直して今の状態とボタンを見せ、「<操作>の応答を受け取れませんでした」の文を出す (#2073)。
 * 読み直さないと、古い status のボタンをもう一度押して 409 (遷移表に無い変更) になり、自分の操作なのに
 * 「別の操作でクーポンの状態が先に変わっていました」と出る。
 * 状態の変更のあとの読み直し (409 のあと・通信の reject のあと) が失敗したら、文と「再試行」を出し、読み直せるまで
 * 状態の変更のボタンを止める (画面の status が DB と食い違っているかもしれないのに、その status を元にしたボタンを出し続けない。
 * プランの詳細と同じ。#2064・#2073)
 * 読み直しが 404 (読み直しの間にクーポンが消えた。uses_count 0 のクーポンは削除できる)・403 (権限が外れた・二段階認証の確認が要る)・
 * 401 (ログインが切れた) で断られたら、読み込み直しても変わらないので、その理由の文を出し「再試行」は出さず、状態の変更のボタンを戻す
 * (プラン・A/B テストの詳細と同じ。#2080)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { couponValidityDay, couponValidUntilPatchValue } from '@/lib/super-admin/coupon-validity';
import { isStatusChangeConflict, operationFailureMessage } from '@/lib/admin/api-error-message';
import { COUPON_INVALID_TRANSITION_ERROR_CODE, couponApplicableToLabel } from '@/lib/super-admin/coupons-schemas';
import {
  NO_RESPONSE_STATE_RELOADED_GUIDE,
  NO_RESPONSE_STATE_RELOAD_FAILED_GUIDE,
  statusChangeNoResponseMessage,
} from '@/lib/super-admin/status-change-no-response';
import { rereadDetailRow } from '@/lib/super-admin/detail-reread';
import {
  AdminScreenError,
  adminActionHttpFailedMessage,
  adminActionNoResponseMessage,
  adminLoadFailedFallback,
  adminLoadFailedMessage,
  adminScreenErrorOfResponse,
  displayableAdminError,
  fetchAdminJson,
  savedRowOfResponse,
} from '@/lib/admin/admin-screen-messages';

/** 読み込みの失敗の文の対象 (「クーポンを読み込めませんでした (HTTP 502)」。#2093 W7) */
const COUPON_SUBJECT = 'クーポン';
/** 保存の失敗の文の操作の名前 (「保存に失敗しました (HTTP 502)」「保存の応答を受け取れませんでした（通信エラー）」。#2093 W7) */
const SAVE_ACTION = '保存';

type Coupon = {
  id: string;
  code: string;
  display_name: string | null;
  discount_type: 'fixed' | 'percentage';
  discount_value: number;
  applicable_to: string;
  applicable_plans: string[];
  valid_from: string;
  valid_until: string;
  max_uses: number | null;
  uses_count: number;
  per_user_limit: number;
  duration_months: number | null;
  gross_margin_preview_jpy: number | null;
  status: string;
  created_by: string;
  created_at: string;
};

type Redemption = {
  id: string;
  user_id: string | null;
  organization_id: string | null;
  subscription_target: string;
  discount_amount_jpy: number;
  redeemed_at: string;
  ended_at: string | null;
};

type RedemptionsResponse = {
  data?: Redemption[];
  meta?: { total?: number; page?: number; per_page?: number };
  error?: { message?: string };
};

/** 適用履歴の API (GET /api/super-admin/coupons/{id}/redemptions) のページ番号は 1 から */
const FIRST_REDEMPTIONS_PAGE = 1;

/** 保存で送る本文 (PATCH /api/super-admin/coupons/{id} の表示名・有効期限・最大利用回数) */
type CouponSaveBody = {
  display_name?: string | null;
  valid_until?: string;
  max_uses?: number | null;
};

/** 最大利用回数の入力欄の文字 (空欄は無制限) */
function maxUsesText(maxUses: number | null): string {
  return maxUses != null ? String(maxUses) : '';
}

/** 入力欄 (表示名・有効期限・最大利用回数) の値。有効期限は JST の暦日 (YYYY-MM-DD)、最大利用回数は文字 (空欄は無制限) */
type CouponInputs = { displayName: string; validUntil: string; maxUses: string };

/** クーポンの行から作る入力欄の値。有効期限 (DB の時刻) は JST の暦日にする (#1483) */
function couponInputsOf(coupon: Coupon): CouponInputs {
  return {
    displayName: coupon.display_name ?? '',
    validUntil: couponValidityDay(coupon.valid_until),
    maxUses: maxUsesText(coupon.max_uses),
  };
}

/**
 * 保存に成功したあとの 1 つの入力欄の値 (#1917)。保存を押したときの値 (atSave) から応答を待つあいだに変えていなければ
 * 保存の応答の行の値 (saved) にし、変えていれば書きかけとして残す (次の保存で送る)
 */
function inputAfterSave(current: string, atSave: string, saved: string): string {
  return current === atSave ? saved : current;
}

/**
 * 保存で送る本文。最後に読んだ・保存したクーポン (coupon) から変えた欄だけを入れる (#1917)。
 * 手を付けていない欄を送ると、画面を開いたあとに別の運営が変えたその欄を、開いたときの古い値で上書きしてしまう
 * (route は送られた項目をそのまま書く)。有効期限は JST の暦日で比べる (#1483 の couponValidUntilPatchValue)。
 * 表示名の空欄は null、最大利用回数の空欄は null (無制限) にする (これまでと同じ)。
 * 手を付けていない入力欄は、読み込み・保存の成功・状態の変更の成功・状態の変更の 409 と通信の reject のあとの読み直しのたびに coupon の値に揃える (handleSave・handleStatusChange・retryReread の applyLatestCoupon) ので、ここで coupon と違う欄は運営が変えた欄
 */
function changedCouponFields(inputs: CouponInputs, coupon: Coupon): CouponSaveBody {
  const body: CouponSaveBody = {};
  if (inputs.displayName !== (coupon.display_name ?? '')) body.display_name = inputs.displayName || null;
  const validUntil = couponValidUntilPatchValue(inputs.validUntil, coupon.valid_until);
  if (validUntil !== undefined) body.valid_until = validUntil;
  if (inputs.maxUses !== maxUsesText(coupon.max_uses)) body.max_uses = inputs.maxUses ? Number(inputs.maxUses) : null;
  return body;
}

/** 保存を押したが、どの入力欄も最後に読んだ・保存した値から変えていなかったときの文 (送らない。#1917) */
const NO_COUPON_CHANGES_MESSAGE = '変更した項目がないので、保存していません';

/** 状態の変更 (PATCH /api/super-admin/coupons/{id} の status) で変えられる状態 */
type CouponStatusChange = 'active' | 'paused';

/** 状態の変更の操作の名前 (確かめる文と失敗の文に使う) */
const STATUS_CHANGE_LABELS: Record<CouponStatusChange, string> = {
  paused: '一時停止',
  active: '再開',
};

/** 状態の変更が失敗したときの文の頭 (後ろに理由を添える) */
function statusChangeFailureSummary(newStatus: CouponStatusChange): string {
  return `${STATUS_CHANGE_LABELS[newStatus]}できませんでした`;
}

/**
 * 状態の変更が 409 (遷移表に無い変更・同時の変更) で断られたときの理由の文の頭 (#2064)。
 * 画面の status が古かった (別の操作で一時停止・再開・期限切れにされていた)。英字の状態の値は出さない
 */
const STATUS_CONFLICT_REASON_HEAD = '別の操作でクーポンの状態が先に変わっていました';

/** 状態の変更が 409 で断られ、クーポンを読み直せたときの理由の文 (#2064) */
const STATUS_CONFLICT_RELOADED_REASON = `${STATUS_CONFLICT_REASON_HEAD}。今の状態を読み込み直しました`;

/** 状態の変更が 409 で断られ、読み直しも失敗したときの理由の文 (「再試行」を出す。#2064・#2073) */
const STATUS_CONFLICT_RELOAD_FAILED_REASON = `${STATUS_CONFLICT_REASON_HEAD}。今の状態を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください`;

/** 読み直しが 404 (読み直しの間にクーポンが消えた) で断られたときの文。読み込み直しても変わらないので「再試行」は出さない (#2080) */
const COUPON_NOT_FOUND_ON_RELOAD_MESSAGE = 'クーポンが見つかりません。一覧に戻って確かめてください';

/**
 * 状態の変更のあとに読み直す理由 (#2073)。
 *   - conflict   : 409 (遷移表に無い変更・同時の変更) で断られた (画面の status が古かった)
 *   - no-response: 通信が reject された (応答を受け取れず、変更が済んだか分からない)
 */
type StatusRereadCause = 'conflict' | 'no-response';

/** 状態の変更のあとの読み直しが失敗し、「再試行」で読み直すのを待っている操作 (#2073) */
type PendingStatusReread = { newStatus: CouponStatusChange; cause: StatusRereadCause };

/**
 * 状態の変更のあとの読み直しの結果 (#2064・#2073・#2080)。
 *   - reloaded   : 読み直せた
 *   - failed     : 読み直せなかった (「再試行」を出し、状態の変更のボタンを止める)
 *   - unavailable: 404 / 403 / 401 で断られた (message は理由の文。読み込み直しても変わらないので「再試行」は出さない)
 */
type StatusRereadResult = { kind: 'reloaded' } | { kind: 'failed' } | { kind: 'unavailable'; message: string };

/** 状態の変更のあとに読み直した・読み直せなかった・読み直しが断られたときの文 (#2064・#2073・#2080) */
function statusRereadMessage(newStatus: CouponStatusChange, cause: StatusRereadCause, result: StatusRereadResult): string {
  if (cause === 'conflict') {
    const reason =
      result.kind === 'reloaded'
        ? STATUS_CONFLICT_RELOADED_REASON
        : result.kind === 'failed'
          ? STATUS_CONFLICT_RELOAD_FAILED_REASON
          : `${STATUS_CONFLICT_REASON_HEAD}。${result.message}`;
    return `${statusChangeFailureSummary(newStatus)}（${reason}）`;
  }
  // 応答を受け取れなかった: 変更が済んでいた (自分の操作) ときにも合うよう「できませんでした」「別の操作で」とは言わない
  const guide =
    result.kind === 'reloaded'
      ? NO_RESPONSE_STATE_RELOADED_GUIDE
      : result.kind === 'failed'
        ? NO_RESPONSE_STATE_RELOAD_FAILED_GUIDE
        : result.message;
  return statusChangeNoResponseMessage(STATUS_CHANGE_LABELS[newStatus], guide);
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  active: { label: '有効', color: 'bg-green-100 text-green-700' },
  paused: { label: '停止中', color: 'bg-yellow-100 text-yellow-700' },
  expired: { label: '期限切れ', color: 'bg-slate-100 text-slate-500' },
};

export default function CouponDetailPage() {
  const params = useParams();
  const couponId = params.id as string;

  const [coupon, setCoupon] = useState<Coupon | null>(null);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [redemptionsTotal, setRedemptionsTotal] = useState<number | null>(null);
  const [redemptionsPage, setRedemptionsPage] = useState(FIRST_REDEMPTIONS_PAGE);
  const [redemptionsError, setRedemptionsError] = useState('');
  const [isLoadingRedemptions, setIsLoadingRedemptions] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  // 保存を押したが送らなかったときの文 (変えた欄が無い。#1917)
  const [saveInfo, setSaveInfo] = useState('');
  // 状態の変更 (一時停止・再開) の応答を待っているか・失敗したときの文
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [statusError, setStatusError] = useState('');
  // 保存か状態の変更のどちらかの応答を待っているか (#2050)。どちらの応答も、その行 (書いたあとの行) をそのまま画面の行にするので、
  // 2 つを重ねると、応答が送った順と逆に届いたとき、後に届いた古い方の行 (例: 一時停止の前の status) が画面に残る。
  // 待つあいだは両方のボタンを止め、押されても送らない。ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り
  const writeInFlightRef = useRef(false);
  // 状態の変更のあとの読み直しが失敗し、まだ読み直せていない操作 (#2073)。あるあいだは文と「再試行」を出し、状態の変更のボタンを止める。
  // ref は描画を待たずに handler で読むための写し
  const [pendingReread, setPendingReread] = useState<PendingStatusReread | null>(null);
  const pendingRereadRef = useRef<PendingStatusReread | null>(null);
  // 「再試行」の読み直しを待っているか
  const [isRereading, setIsRereading] = useState(false);
  const isWriting = isSaving || isChangingStatus || isRereading;
  const [activeTab, setActiveTab] = useState<'detail' | 'redemptions'>('detail');

  const [displayName, setDisplayName] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [maxUses, setMaxUses] = useState('');

  const fetchCoupon = useCallback(async () => {
    setIsLoading(true);
    try {
      // 失敗の応答は ok を先に確かめて本文の日本語の文か「クーポンを読み込めませんでした (HTTP 502)」にし、通信そのものの失敗と
      // 200 の読めない本文だけを「（通信エラー）」にする (JSON でない 502 を「ネットワークエラー」と見せない。#2093 W7)
      const body = await fetchAdminJson(`/api/super-admin/coupons/${couponId}`, COUPON_SUBJECT);
      const loaded = (body as { data?: Coupon | null }).data;
      if (!loaded) throw new AdminScreenError(adminLoadFailedMessage(COUPON_SUBJECT, null));
      const inputs = couponInputsOf(loaded);
      setCoupon(loaded);
      setDisplayName(inputs.displayName);
      // 有効期限 (DB の時刻) を JST の暦日にして編集欄に入れる (#1483)
      setValidUntil(inputs.validUntil);
      setMaxUses(inputs.maxUses);
    } catch (err) {
      setError(displayableAdminError(err, adminLoadFailedFallback(COUPON_SUBJECT)));
    } finally {
      setIsLoading(false);
    }
  }, [couponId]);

  // 適用履歴 (#1571): API の既定のページ送り (1 ページ 50 件・meta.total) で読む。
  // 1 ページ目は ?page を付けずに呼び (API の既定)、「さらに読み込む」で次のページを足していく。
  // 取得に失敗したら黙って捨てず、画面に出す (#1570 の 404 が長く気づかれなかったため)。
  const fetchRedemptions = useCallback(async (page: number = FIRST_REDEMPTIONS_PAGE) => {
    if (!coupon) return;
    const isFirstPage = page === FIRST_REDEMPTIONS_PAGE;
    setIsLoadingRedemptions(true);
    setRedemptionsError('');
    try {
      const url = `/api/super-admin/coupons/${coupon.id}/redemptions${isFirstPage ? '' : `?page=${page}`}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({})) as RedemptionsResponse;
      if (!res.ok || !Array.isArray(data.data)) {
        // 1 ページ目が取れなかったときは、前に読んだ履歴を「いまの履歴」として残さない (次のページの失敗なら、読んだ分は残す)
        if (isFirstPage) {
          setRedemptions([]);
          setRedemptionsTotal(null);
        }
        setRedemptionsError(data.error?.message ?? '適用履歴の取得に失敗しました');
        return;
      }
      const rows = data.data;
      setRedemptions((prev) => (isFirstPage ? rows : [...prev, ...rows]));
      setRedemptionsTotal(data.meta?.total ?? null);
      setRedemptionsPage(page);
    } catch {
      if (isFirstPage) {
        setRedemptions([]);
        setRedemptionsTotal(null);
      }
      setRedemptionsError('ネットワークエラーで適用履歴を取得できませんでした');
    } finally {
      setIsLoadingRedemptions(false);
    }
  }, [coupon]);

  useEffect(() => {
    fetchCoupon();
  }, [fetchCoupon]);

  useEffect(() => {
    if (activeTab === 'redemptions') fetchRedemptions(FIRST_REDEMPTIONS_PAGE);
  }, [activeTab, fetchRedemptions]);

  /**
   * 書いたあと・読み直したあとの最新の行 (latest) を画面の行にする。入力欄は、inputsBefore (押したときの最後に読んだ・保存した行の値)
   * から変えていない欄だけ latest の値に揃え、書きかけは残す (inputAfterSave。#1917)
   */
  const applyLatestCoupon = (latest: Coupon, inputsBefore: CouponInputs) => {
    const latestInputs = couponInputsOf(latest);
    setCoupon(latest);
    setDisplayName((current) => inputAfterSave(current, inputsBefore.displayName, latestInputs.displayName));
    setValidUntil((current) => inputAfterSave(current, inputsBefore.validUntil, latestInputs.validUntil));
    setMaxUses((current) => inputAfterSave(current, inputsBefore.maxUses, latestInputs.maxUses));
  };

  /** 状態の変更のあとの読み直しを待っている操作を記録する (null で外す。#2073) */
  const markPendingReread = (pending: PendingStatusReread | null) => {
    pendingRereadRef.current = pending;
    setPendingReread(pending);
  };

  /**
   * 409 のあと・通信の reject のあとにクーポンを読み直す (全体を「読み込み中」にしない。#2064・#2073)。
   * 404 / 403 / 401 は unavailable (理由の文つき。401 は「ログインし直してください」。src/lib/super-admin/detail-reread.ts の
   * rereadUnavailableMessage。#2080)、それ以外の失敗は failed
   */
  const rereadCoupon = () => rereadDetailRow<Coupon>(`/api/super-admin/coupons/${couponId}`, COUPON_NOT_FOUND_ON_RELOAD_MESSAGE);

  const handleSave = async () => {
    // 状態の変更の応答を待つあいだは送らない (#2050。writeInFlightRef)
    if (!coupon || writeInFlightRef.current) return;
    setSaveError('');
    setSaveSuccess(false);
    setSaveInfo('');
    // 送るのは、最後に読んだ・保存した値から変えた欄だけ (手を付けていない欄を古い値で上書きしない。#1917)。
    // 有効期限は JST の暦日 (YYYY-MM-DD) のまま送り、API がその日の JST 23:59:59 の時刻にして書く (#1483)。
    // 押したときの入力欄の値は写しておく (応答を待つあいだに変えた欄を、保存の成功のあとに見分けるため)
    const inputsAtSave: CouponInputs = { displayName, validUntil, maxUses };
    const changes = changedCouponFields(inputsAtSave, coupon);
    if (Object.keys(changes).length === 0) {
      setSaveInfo(NO_COUPON_CHANGES_MESSAGE);
      return;
    }
    writeInFlightRef.current = true;
    setIsSaving(true);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/super-admin/coupons/${couponId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(changes),
        });
      } catch {
        throw new AdminScreenError(adminActionNoResponseMessage(SAVE_ACTION));
      }
      // ok を先に確かめる (JSON でない 502 を「ネットワークエラー」と見せない。本文に日本語の文が無ければ「保存に失敗しました (HTTP 502)」。#2093 W7)
      if (!res.ok) throw await adminScreenErrorOfResponse(res, (status) => adminActionHttpFailedMessage(SAVE_ACTION, status));
      // 成功の応答の本文が読めない: 保存は済んでいるかもしれないので、失敗とは言わず応答を受け取れなかった文にする (#2093 W7)
      const saved = await savedRowOfResponse<Coupon>(res);
      if (!saved) throw new AdminScreenError(adminActionNoResponseMessage(SAVE_ACTION));
      // 保存の応答の行 (書いたあとの最新の行) を新しい比べる元にし、手を付けていない入力欄もその行の値に揃える (#1917)。
      // 送らなかった欄には、画面を開いたあとに別の運営が変えた値が入っていることがある。比べる元だけを新しくして入力欄を
      // 古い値のままにすると、その欄が変えた欄に見え、次の保存 (何も変えずに押しても) で開いたときの古い値を送って、
      // 別の運営の変更を上書きしてしまう。応答を待つあいだに変えた欄は書きかけとして残す (次の保存で送る)
      applyLatestCoupon(saved, inputsAtSave);
      setSaveSuccess(true);
      // 保存の応答の行は書いたあとの最新の行 (status も今の値) なので、状態の変更のあとの読み直しの失敗は解ける (#2073)
      const pending = pendingRereadRef.current;
      if (pending) {
        setStatusError(statusRereadMessage(pending.newStatus, pending.cause, { kind: 'reloaded' }));
        markPendingReread(null);
      }
    } catch (err) {
      setSaveError(displayableAdminError(err, `${SAVE_ACTION}に失敗しました`));
    } finally {
      writeInFlightRef.current = false;
      setIsSaving(false);
    }
  };

  /**
   * 状態の変更のあとに読み直し、結果に合わせて文を出す (#2064・#2073)。inputsBefore は押したときの最後に読んだ・保存した行の
   * 入力欄の値 (書きかけを残すため)。読み直せなかったら「再試行」を待つ操作として記録し、状態の変更のボタンを止める。
   * 404 / 403 / 401 で断られたら、理由の文を出し、「再試行」は待たない (読み込み直しても変わらないので、ボタンを止め続けない。#2080)
   */
  const rereadAfterStatusChange = async (newStatus: CouponStatusChange, cause: StatusRereadCause, inputsBefore: CouponInputs) => {
    const outcome = await rereadCoupon();
    if (outcome.kind === 'loaded') applyLatestCoupon(outcome.row, inputsBefore);
    const result: StatusRereadResult =
      outcome.kind === 'loaded' ? { kind: 'reloaded' } : outcome.kind === 'failed' ? { kind: 'failed' } : outcome;
    setStatusError(statusRereadMessage(newStatus, cause, result));
    markPendingReread(outcome.kind === 'failed' ? { newStatus, cause } : null);
  };

  /** 「再試行」: 状態の変更のあとの失敗した読み直しをやり直す (#2073) */
  const retryReread = async () => {
    const pending = pendingRereadRef.current;
    if (!coupon || !pending || writeInFlightRef.current) return;
    writeInFlightRef.current = true;
    setIsRereading(true);
    try {
      await rereadAfterStatusChange(pending.newStatus, pending.cause, couponInputsOf(coupon));
    } finally {
      writeInFlightRef.current = false;
      setIsRereading(false);
    }
  };

  /**
   * 状態の変更 (一時停止・再開)。失敗の応答を黙って捨てず、操作の名前と理由を画面に出す
   * (403 は理由の文 (二段階認証の確認が要る など) だけを通す。operationFailureMessage)。
   * 成功したら PATCH の応答の行 (書いたあとの最新の行) で表示を新しくする。全体を「読み込み中」にして読み直さない。
   * 入力欄は保存の経路と同じく、手を付けていない欄だけ応答の行の値に揃え、書きかけは残す (inputAfterSave。#1917)。
   * 保存の応答を待つあいだは送らない (#2050。writeInFlightRef)。
   * 409 で、画面の status が古かった (遷移表に無い変更 OP_COUPON_INVALID_TRANSITION・同時の変更 CONFLICT_STALE_DATA) ときは、
   * クーポンを読み直して状態の表示とボタンを今の状態にし、日本語の文を出す (書きかけは残す。#2064)。
   * 通信が reject されたときも読み直す (サーバーが変更を済ませてから応答が切れたことがあるため。#2073)。
   * 読み直しが失敗して、まだ読み直せていないあいだは送らない (#2073。画面の status が古いかもしれない)
   */
  const handleStatusChange = async (newStatus: CouponStatusChange) => {
    if (!coupon || writeInFlightRef.current || pendingRereadRef.current) return;
    if (!confirm(`このクーポンを${STATUS_CHANGE_LABELS[newStatus]}しますか？`)) return;
    // 押したときの最後に読んだ・保存した行から作る入力欄の値 (入力欄がこれと同じなら手を付けていない欄)
    const loadedInputs = couponInputsOf(coupon);
    setStatusError('');
    writeInFlightRef.current = true;
    setIsChangingStatus(true);
    try {
      const res = await fetch(`/api/super-admin/coupons/${couponId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        if (isStatusChangeConflict(res.status, body, COUPON_INVALID_TRANSITION_ERROR_CODE)) {
          await rereadAfterStatusChange(newStatus, 'conflict', loadedInputs);
          return;
        }
        setStatusError(operationFailureMessage(statusChangeFailureSummary(newStatus), res.status, body));
        return;
      }
      // 応答は { data: 書いたあとの行 } (保存の経路と同じ形。route は .update().select() の行を返す)
      applyLatestCoupon((await res.json() as { data: Coupon }).data, loadedInputs);
    } catch {
      // 応答を受け取れなかった (通信が reject した: オフライン・接続が切れたなど。成功の応答の本文を読み切れなかったときも)。
      // 変更が済んだかは分からないので、読み直して今の状態を見せる (#2073。rereadAfterStatusChange は投げない)
      await rereadAfterStatusChange(newStatus, 'no-response', loadedInputs);
    } finally {
      writeInFlightRef.current = false;
      setIsChangingStatus(false);
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-48 text-slate-400">読み込み中...</div>;
  }

  if (error || !coupon) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
        {error || 'クーポンが見つかりません'}
      </div>
    );
  }

  const statusInfo = STATUS_LABELS[coupon.status] ?? { label: coupon.status, color: 'bg-slate-100 text-slate-500' };
  // 状態の変更のボタンを止めるか (応答を待つあいだ・読み直しが失敗してまだ読み直せていないあいだ。#2050・#2073)
  const statusButtonsDisabled = isWriting || pendingReread !== null;

  return (
    <div className="max-w-3xl mx-auto">
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/super-admin/coupons" className="text-slate-400 hover:text-slate-600 text-sm">
            ← 一覧
          </Link>
          <span className="text-slate-300">/</span>
          <code className="font-mono font-bold text-slate-900">{coupon.code}</code>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
            {statusInfo.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {coupon.status === 'active' && (
            <button
              onClick={() => handleStatusChange('paused')}
              disabled={statusButtonsDisabled}
              className="px-3 py-1.5 border border-yellow-300 text-yellow-600 rounded-lg text-xs font-medium hover:bg-yellow-50 transition-colors disabled:opacity-50"
            >
              一時停止
            </button>
          )}
          {coupon.status === 'paused' && (
            <button
              onClick={() => handleStatusChange('active')}
              disabled={statusButtonsDisabled}
              className="px-3 py-1.5 bg-green-500 text-white rounded-lg text-xs font-medium hover:bg-green-600 transition-colors disabled:opacity-50"
            >
              再開する
            </button>
          )}
        </div>
      </div>

      {statusError && (
        <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm flex items-center justify-between gap-4">
          <p role="alert" data-testid="status-change-error">
            {statusError}
          </p>
          {pendingReread && (
            <button
              type="button"
              onClick={() => void retryReread()}
              disabled={isWriting}
              className="shrink-0 underline whitespace-nowrap hover:text-red-900 disabled:opacity-50"
            >
              {isRereading ? '読み込み中...' : '再試行'}
            </button>
          )}
        </div>
      )}

      {/* タブ */}
      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {(['detail', 'redemptions'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-orange-500 text-orange-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab === 'detail' ? '詳細' : `適用履歴 (${coupon.uses_count})`}
          </button>
        ))}
      </div>

      {/* 詳細タブ */}
      {activeTab === 'detail' && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
          <div className="grid grid-cols-2 gap-4 pb-4 border-b border-slate-100">
            <div>
              <span className="text-xs text-slate-500">割引</span>
              <p className="text-2xl font-bold text-slate-800">
                {coupon.discount_type === 'percentage'
                  ? `${coupon.discount_value}%`
                  : `¥${coupon.discount_value.toLocaleString()} OFF`}
              </p>
            </div>
            <div>
              <span className="text-xs text-slate-500">利用数</span>
              <p className="text-2xl font-bold text-slate-800">
                {coupon.uses_count}
                {coupon.max_uses != null && <span className="text-slate-400 text-base"> / {coupon.max_uses}</span>}
              </p>
            </div>
            {coupon.gross_margin_preview_jpy != null && (
              <div>
                <span className="text-xs text-slate-500">実質粗利プレビュー</span>
                <p className="text-lg font-semibold text-slate-700">
                  ¥{coupon.gross_margin_preview_jpy.toLocaleString()}
                </p>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">表示名</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => { setDisplayName(e.target.value); setSaveInfo(''); }}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">有効期限</label>
              <input
                type="date"
                value={validUntil}
                onChange={(e) => { setValidUntil(e.target.value); setSaveInfo(''); }}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">最大利用回数</label>
              <input
                type="number"
                value={maxUses}
                onChange={(e) => { setMaxUses(e.target.value); setSaveInfo(''); }}
                min={coupon.uses_count}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                placeholder="無制限"
              />
            </div>
          </div>

          <div className="text-xs text-slate-400 grid grid-cols-2 gap-2">
            <div>適用対象: {couponApplicableToLabel(coupon.applicable_to)}</div>
            <div>1 ユーザー上限: {coupon.per_user_limit} 回</div>
            <div>割引期間: {coupon.duration_months != null ? `${coupon.duration_months} ヶ月` : 'ずっと'}</div>
            <div>作成日: {new Date(coupon.created_at).toLocaleDateString('ja-JP')}</div>
          </div>

          {saveError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {saveError}
            </div>
          )}
          {saveInfo && (
            <div
              data-testid="save-info"
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

          <div className="flex justify-end pt-2">
            <button
              onClick={handleSave}
              disabled={isWriting}
              className="px-5 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50"
            >
              {isSaving ? '保存中...' : '保存する'}
            </button>
          </div>
        </div>
      )}

      {/* 適用履歴タブ */}
      {activeTab === 'redemptions' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {redemptionsError && (
            <div role="alert" data-testid="redemptions-error" className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">
              {redemptionsError}
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-slate-600">適用日</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">対象</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">割引額</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">ステータス</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {redemptions.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-600">
                    {new Date(r.redeemed_at).toLocaleDateString('ja-JP')}
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-xs">
                    {r.subscription_target} / {r.user_id ? r.user_id.slice(0, 8) : r.organization_id?.slice(0, 8)}...
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-800">
                    ¥{r.discount_amount_jpy.toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      r.ended_at ? 'bg-slate-100 text-slate-500' : 'bg-green-100 text-green-700'
                    }`}>
                      {r.ended_at ? '終了' : '有効'}
                    </span>
                  </td>
                </tr>
              ))}
              {redemptions.length === 0 && !redemptionsError && !isLoadingRedemptions && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                    適用履歴がありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {redemptionsTotal !== null && redemptions.length < redemptionsTotal && (
            <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between text-sm text-slate-500">
              <span>{redemptions.length} / {redemptionsTotal} 件を表示</span>
              <button
                type="button"
                data-testid="redemptions-load-more"
                onClick={() => fetchRedemptions(redemptionsPage + 1)}
                disabled={isLoadingRedemptions}
                className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {isLoadingRedemptions ? '読み込み中...' : 'さらに読み込む'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
