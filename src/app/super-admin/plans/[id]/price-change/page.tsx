"use client";

/**
 * /super-admin/plans/[id]/price-change — 価格変更フロー
 * operator/03-ui-spec.md §24 (価格の変更の画面) / operator/04-plan-management.md §3.3 準拠
 *
 * Step1: 新価格入力 + 影響シミュレーション
 * Step2: 確認 → 実行
 *
 * #1102 (オーナー判断 2026-10-08): 価格変更は新規契約だけに適用する。適用範囲の選択 (次回更新時から / 即時) は
 * 実際には既存契約へ反映されない偽の選択肢だったため、画面から外した。既存の契約者の請求額は変わらない。
 * 月額・年額は、変える方だけを送る (両方を同時に変えてもよい)。
 *
 * 失敗の応答は ok を先に確かめ、本文の日本語の文か「<対象>を読み込めませんでした (HTTP n)」「<操作>に失敗しました (HTTP n)」を出す。
 * 通信そのものの失敗だけを「（通信エラー）」にする (JSON でない 502 を「ネットワークエラー」と見せない。#2093 W7)。
 * プランの読み込みが失敗したら「読み込み中」のまま止めず、読み込めなかった文を出す。
 * 価格の変更の成功の応答の本文は使わないので読まない (読めなくても、済んだので履歴の画面へ移る)。
 *
 * #2101 X1: 以前は、価格の変更の応答を受け取れなかった (fetch の reject・本文の無い 502 / 504) とき、失敗の文を出してボタンを戻すだけで、
 * 読み直しも送信の止めも無かった。押し直すと、1 回目で済んでいても同じ金額でもう一度 Stripe に新しい Price が作られ、履歴と監査に 2 行目が入った。
 * いまは応答を受け取れなかったら (AdminActionNoResponseError) プランを読み直し、価格が送った値になっていれば済んだとして履歴の画面へ移る。
 * 送った値になっていなければ、画面のプランを読み直した値にして、済んでいないことを出す (もう一度実行できる。同じ価格の押し直しは
 * route が 409 OP_PRICE_UNCHANGED で断る)。読み直せなければ送信を止め、「済んだか分かりません。履歴で確かめてください」と履歴へのリンクを出す。
 * 読み直しが 401 / 403 で断られたら、その理由の文 (401 は「ログインし直してください」・403 は理由の文) を添える
 * (#2101 integrity-1030c。src/lib/super-admin/detail-reread.ts の rereadUnavailableMessage と同じ文)。
 * 409 OP_PRICE_UNCHANGED (すでにこの価格) は済んだものとして履歴の画面へ移る (src/lib/super-admin/price-change-unchanged.ts)。
 *
 * #2107 Y2: 以前は今の価格と違う間隔があるときだけ送れたので、販売開始の手順 (docs/design/billing/03-paid-plans-and-iap.md §12 の順 3。
 * migration が入れた価格のまま Stripe の Price を作り ID を入れる) が画面からできなかった。いまは送る間隔を route と同じ判定
 * (pendingPriceChange) で決める: 今と違う価格の間隔と、Stripe の同期が要るプラン (GET の stripe_price_sync_expected) で
 * Price ID がまだ無い間隔 (今と同じ価格でも) を送る。価格を変えずに Price を作るだけのときは、実行のボタンを「Stripe の Price を作る」にする。
 * 応答を受け取れなかったあとの「済んだか」も route と同じ判定 (priceChangeAlreadyApplied) で、価格が同じでも Price ID がまだ無ければ済んだとしない。
 * #2107 Y3: 履歴の画面は planDetailHref(id, 'history') (プラン詳細は URL の tab を初めのタブにする)。
 * #2107 Y6: 読み直したプランが送った内容になっていないときは「まだ処理中のことがあります」を添える (route の 1 回目がまだ走っていることがある)。
 * #2112 Z1-1: Stripe の同期が要らない (GET の stripe_price_sync_expected が false) プランで、Price ID がまだ無い間隔があり、今と同じ価格のままのときは、
 * 「変更がありません」に加えて、なぜ Stripe の Price を作れないか (Product ID が未設定・この環境に Stripe の鍵が無い) を出す
 * (stripePriceUnavailableReasonOf)。以前は「変更がありません」とだけ出し、販売開始の手順がどこで止まっているかが分からなかった。
 * 適用範囲の名前は src/lib/super-admin/plans-schemas.ts の PRICE_APPLIES_TO_LABELS から引く (プラン詳細の履歴のタブと同じ。#2112 Z1-2)。
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ORG_SUBSCRIPTION_PLAN_ROW_NOTE, countsOrganizationsFor } from '@/lib/super-admin/plan-subscribers';
import {
  AdminActionNoResponseError,
  AdminScreenError,
  adminActionErrorOfBody,
  adminActionHttpFailedMessage,
  adminActionNoResponseMessage,
  adminLoadFailedFallback,
  adminLoadFailedMessage,
  adminScreenErrorOfResponse,
  displayableAdminError,
  fetchAdminJson,
  readFailureBody,
} from '@/lib/admin/admin-screen-messages';
import {
  isPriceUnchangedBody,
  pendingPriceChange,
  priceChangeAlreadyApplied,
  sentPricesMatchPlan,
  type PlanCurrentPricesWithStripe,
  type PriceChangeSentPrices,
} from '@/lib/super-admin/price-change-unchanged';
import { planDetailHref } from '@/lib/super-admin/plan-detail-tab';
import { PRICE_APPLIES_TO_LABELS } from '@/lib/super-admin/plans-schemas';
import { rereadDetailRow } from '@/lib/super-admin/detail-reread';

type ImpactData = {
  /** 新規契約のみなので常に 0 (既存契約は現行価格のまま) */
  affected_subscription_count: number;
  affected_mrr_change_jpy: number;
  current_monthly_price_jpy: number;
  new_monthly_price_jpy: number;
  applies_to: string;
  effective_timing: string;
};

type Plan = {
  id: string;
  plan_key: string;
  /** 組織のプランの行 (org_*) かの判定に使う (#1912) */
  plan_type: string | null;
  display_name: string;
  monthly_price_jpy: number | null;
  yearly_price_jpy: number | null;
  status: string;
  /** 月額の Stripe Price ID (#1102)。まだ無いときは null */
  stripe_price_id?: string | null;
  /** 年額の Stripe Price ID (#1102)。まだ無いときは null */
  stripe_yearly_price_id?: string | null;
  /** 価格の変更で Stripe の Price を作るか (Stripe の鍵があり、stripe_product_id がある。GET が返す。#2107 Y2) */
  stripe_price_sync_expected?: boolean;
  /** Stripe の商品 (Product) の ID。まだ無いときは null (Stripe の Price を作れない理由を出し分けるのに使う。#2112 Z1-1) */
  stripe_product_id?: string | null;
};

/** route と同じ判定に渡すプランの値 (Price ID が本文に無いときは「まだ無い」) */
function planStripeStateOf(plan: Plan): PlanCurrentPricesWithStripe {
  return {
    monthly_price_jpy: plan.monthly_price_jpy,
    yearly_price_jpy: plan.yearly_price_jpy,
    stripe_price_id: plan.stripe_price_id ?? null,
    stripe_yearly_price_id: plan.stripe_yearly_price_id ?? null,
  };
}

/** Stripe の Price を作るか (GET の本文に無い・true でないときは作らない = 今と同じ価格の間隔は送らない) */
function stripePriceSyncExpectedOf(plan: Plan): boolean {
  return plan.stripe_price_sync_expected === true;
}

/** 適用範囲は新規契約のみ (選択肢ではなく、固定の説明として表示する。名前は履歴のタブと同じ表から引く。#2112 Z1-2) */
const APPLIES_TO_LABEL = PRICE_APPLIES_TO_LABELS.new_only;

/**
 * Stripe の Price を作れない理由 (#2112 Z1-1)。
 *   - product-missing: プランに Stripe の Product ID が無い (プラン詳細の基本情報で入れる)
 *   - key-missing    : Product ID はあるが、この環境に Stripe の鍵が無い (GET の stripe_price_sync_expected が false)
 */
type StripePriceUnavailableReason = 'product-missing' | 'key-missing';

/**
 * Price ID がまだ無い間隔があるのに、Stripe の Price を作れないときの理由 (作れる・作るものが無いときは null。#2112 Z1-1)。
 * 価格が無い間隔 (月額・年額が null) は Price を作らないので数えない
 */
function stripePriceUnavailableReasonOf(plan: Plan): StripePriceUnavailableReason | null {
  if (stripePriceSyncExpectedOf(plan)) return null;
  const monthlyMissing = plan.monthly_price_jpy != null && !plan.stripe_price_id;
  const yearlyMissing = plan.yearly_price_jpy != null && !plan.stripe_yearly_price_id;
  if (!monthlyMissing && !yearlyMissing) return null;
  return plan.stripe_product_id ? 'key-missing' : 'product-missing';
}

/** 価格を変えないとき、Stripe の Price を作れない理由の文 (#2112 Z1-1) */
const STRIPE_PRICE_UNAVAILABLE_MESSAGES: Readonly<Record<StripePriceUnavailableReason, string>> = {
  'product-missing':
    'このプランには Stripe の Product ID が入っていないので、Stripe の Price は作れません。プラン詳細の基本情報で Stripe の Product ID を入れて保存してから、今の価格のまま進めて「Stripe の Price を作る」を押してください。',
  'key-missing': 'この環境には Stripe の鍵が無いので、Stripe の Price は作れません。',
};

/** 理由の文に添える、プラン詳細の基本情報へのリンクの文 (Product ID が無いときだけ。#2112 Z1-1) */
const OPEN_PLAN_BASIC_TAB_LABEL = 'プラン詳細の基本情報を開く';

/** 読み込みの失敗の文の対象 (「プランを読み込めませんでした (HTTP 502)」。#2093 W7) */
const PLAN_SUBJECT = 'プラン';
/** シミュレーションの失敗の文の操作の名前 (「影響のシミュレーションに失敗しました (HTTP 502)」。#2093 W7) */
const SIMULATE_ACTION = '影響のシミュレーション';
/** 価格の変更の失敗の文の操作の名前 (「価格変更に失敗しました (HTTP 502)」。#2093 W7) */
const PRICE_CHANGE_ACTION = '価格変更';
/** 409 (Conflict) の HTTP ステータス。本文の code が OP_PRICE_UNCHANGED なら、価格はもう送った値になっている (#2101 X1) */
const HTTP_CONFLICT = 409;
/** 価格の変更の応答を受け取れず、プランも読み直せなかったときの案内 (送信を止め、履歴で確かめさせる。#2101 X1) */
const PRICE_CHANGE_UNCONFIRMED_GUIDE = '済んだか分かりません。履歴で確かめてください';
/**
 * 価格の変更の応答を受け取れず、読み直したプランが送った価格になっていなかったときの案内 (#2101 X1)。
 * route の 1 回目がまだ走っていることがあるので、その旨を添え、すぐ押し直させずに履歴で確かめさせる
 * (押し直すと進行中の 409 になる。#2107 Y6)
 */
const PRICE_CHANGE_NOT_APPLIED_GUIDE =
  '読み直したプランの価格は、送った価格になっていません。まだ処理中のことがあります。しばらくしてから読み込み直して履歴で確かめ、必要ならもう一度実行してください';
/** 価格は送った値だが、Stripe の Price ID がまだ入っていなかったとき (販売開始の Price の登録。#2107 Y2・Y6) */
const STRIPE_PRICE_NOT_CREATED_GUIDE =
  '読み直したプランには、まだ Stripe の Price が入っていません。まだ処理中のことがあります。しばらくしてから読み込み直して履歴で確かめ、必要ならもう一度実行してください';
/** 確認の画面で、今と同じ価格のまま Stripe の Price を作る間隔に添える文 (#2107 Y2) */
const STRIPE_PRICE_CREATED_NOTE = 'Stripe の Price を作ります';
/** 入力の画面で、価格を変えずに Stripe の Price を作るだけのときの案内 (#2107 Y2) */
const STRIPE_PRICE_MISSING_NOTE =
  'このプランは、月額・年額のどちらかの Stripe の Price がまだありません。今と同じ価格のまま進めると、その Stripe の Price を作って登録します (販売開始の手順)。';
/** 実行のボタンの文 (価格を変えるとき) */
const EXECUTE_PRICE_CHANGE_LABEL = '価格変更を実行する';
/** 実行のボタンの文 (価格は変えず、Price ID がまだ無い間隔の Stripe の Price を作るだけのとき。#2107 Y2) */
const CREATE_STRIPE_PRICE_LABEL = 'Stripe の Price を作る';

export default function PriceChangePage() {
  const params = useParams();
  const router = useRouter();
  const planId = params.id as string;

  const [plan, setPlan] = useState<Plan | null>(null);
  const [newMonthlyPrice, setNewMonthlyPrice] = useState('');
  const [newYearlyPrice, setNewYearlyPrice] = useState('');
  const [reason, setReason] = useState('');
  const [effectiveAt, setEffectiveAt] = useState(new Date().toISOString().slice(0, 16));
  const [impact, setImpact] = useState<ImpactData | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState('');
  const [simulateError, setSimulateError] = useState('');
  // プランの読み込みの失敗の文 (「読み込み中」のまま止めない。#2093 W7)
  const [loadError, setLoadError] = useState('');
  // 価格の変更の応答を受け取れず、プランも読み直せなかったときの文。空でないあいだは送信を止める (#2101 X1)
  const [unconfirmedMessage, setUnconfirmedMessage] = useState('');
  // 再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り。送信中・済んだか分からないあいだは送らない (#2101 X1)
  const executingRef = useRef(false);
  const unconfirmedRef = useRef(false);
  // 価格変更履歴のタブを開く (プラン詳細は URL の tab を初めのタブにする。#2107 Y3)
  const historyHref = planDetailHref(planId, 'history');

  useEffect(() => {
    const fetchPlan = async () => {
      try {
        const body = await fetchAdminJson(`/api/super-admin/plans/${planId}`, PLAN_SUBJECT);
        const loaded = (body as { data?: Plan | null }).data;
        // 200 なのに本文に行が無いときも読み込めなかった文にする
        if (!loaded) throw new AdminScreenError(adminLoadFailedMessage(PLAN_SUBJECT, null));
        setPlan(loaded);
        setNewMonthlyPrice(loaded.monthly_price_jpy != null ? String(loaded.monthly_price_jpy) : '');
        setNewYearlyPrice(loaded.yearly_price_jpy != null ? String(loaded.yearly_price_jpy) : '');
      } catch (err) {
        setLoadError(displayableAdminError(err, adminLoadFailedFallback(PLAN_SUBJECT)));
      }
    };
    void fetchPlan();
  }, [planId]);

  // #1041 round-4 (W1): 月額・年額入力欄は常に現在価格で prefill されているため、
  // 何も変更していない状態でシミュレーション/実行を叩けてしまっていた
  // (handleExecute 内で送信直前に検知していたが、UI 上はボタンが有効なままだった)。
  // ここで算出し、シミュレーション/実行ボタンの有効・無効判定と handleSimulate/
  // handleExecute の全てで同じ値を使う (ロジック重複を避ける)。
  const monthlyChanged = newMonthlyPrice !== '' && Number(newMonthlyPrice) !== plan?.monthly_price_jpy;
  const yearlyChanged = newYearlyPrice !== '' && Number(newYearlyPrice) !== plan?.yearly_price_jpy;
  // #2107 Y2: 送る間隔は route と同じ判定 (pendingPriceChange) で決める。今と違う価格の間隔に加え、Stripe の同期が要るプランで
  // Price ID がまだ無い間隔は、今と同じ価格でも送る (販売開始の Price の登録)。ID のある間隔・Stripe の同期が要らないプランは、
  // これまでどおり今と同じ価格なら送らない (送ると変えていない方の Price が作り直される。#1041 round-3 (C2))
  const toSend: PriceChangeSentPrices = plan
    ? pendingPriceChange(
        planStripeStateOf(plan),
        {
          new_monthly_price_jpy: newMonthlyPrice !== '' ? Number(newMonthlyPrice) : null,
          new_yearly_price_jpy: newYearlyPrice !== '' ? Number(newYearlyPrice) : null,
        },
        stripePriceSyncExpectedOf(plan),
      )
    : { new_monthly_price_jpy: null, new_yearly_price_jpy: null };
  const monthlySent = toSend.new_monthly_price_jpy != null;
  const yearlySent = toSend.new_yearly_price_jpy != null;
  const hasAnyChange = monthlySent || yearlySent;
  // 価格は変えず、Stripe の Price を作るだけか (実行のボタンの文を変える。#2107 Y2)
  const createsStripePriceOnly = hasAnyChange && !monthlyChanged && !yearlyChanged;
  // 今と同じ価格のままで、Price ID がまだ無い間隔の Stripe の Price を作れない理由 (#2112 Z1-1)
  const stripePriceUnavailableReason = plan && !hasAnyChange ? stripePriceUnavailableReasonOf(plan) : null;

  const handleSimulate = useCallback(async () => {
    if (!newMonthlyPrice && !newYearlyPrice) {
      setSimulateError('月額または年額を入力してください');
      return;
    }
    // #1041 round-4 (W1): ボタンの disabled 判定と同じ条件を関数内でも検証する
    // (defense in depth。プログラム的な呼び出しでも変更なしでは実行させない)。
    if (!hasAnyChange) {
      setSimulateError('変更がありません');
      return;
    }
    setIsSimulating(true);
    setSimulateError('');
    try {
      const params = new URLSearchParams();
      if (newMonthlyPrice) params.set('new_monthly_price_jpy', newMonthlyPrice);
      let res: Response;
      try {
        res = await fetch(`/api/super-admin/plans/${planId}/price-impact?${params.toString()}`);
      } catch {
        throw new AdminScreenError(adminActionNoResponseMessage(SIMULATE_ACTION));
      }
      // ok を先に確かめる (JSON でない 502 を「ネットワークエラー」と見せない。#2093 W7)
      if (!res.ok) throw await adminScreenErrorOfResponse(res, (status) => adminActionHttpFailedMessage(SIMULATE_ACTION, status));
      const body: unknown = await res.json().catch(() => null);
      const loadedImpact = (body as { data?: ImpactData | null } | null)?.data;
      if (!loadedImpact) throw new AdminScreenError(adminActionNoResponseMessage(SIMULATE_ACTION));
      setImpact(loadedImpact);
    } catch (err) {
      setSimulateError(displayableAdminError(err, `${SIMULATE_ACTION}に失敗しました`));
    } finally {
      setIsSimulating(false);
    }
  }, [newMonthlyPrice, newYearlyPrice, planId, hasAnyChange]);

  /**
   * 価格の変更の応答を受け取れなかったあと、プランを読み直して、送った内容になっているか (済んだか) を確かめる (#2101 X1)。
   * 「済んだか」は route と同じ判定 (priceChangeAlreadyApplied): 価格が送った値で、Stripe の同期が要るプランなら送った間隔の
   * Price ID も入っていること (#2107 Y2)。済んでいれば履歴の画面へ移る。済んでいなければ画面のプランを読み直した値にして、
   * 済んでいないことを出す (価格はなっているが Price ID がまだ無いときと、価格がまだのときで文を分ける。#2107 Y2・Y6)。
   * 読み直せなければ、済んだか分からないので送信を止め、履歴で確かめさせる。
   * 読み直しが 401 / 403 なら、読み込み直しても変わらない理由の文 (「ログインし直してください」・403 の理由の文) を添える
   * (404 は理由の文にしない。これまでどおり済んだか分からない文だけ。#2101 integrity-1030c)
   */
  const confirmUnconfirmedPriceChange = async (sent: PriceChangeSentPrices, summary: string) => {
    const reread = await rereadDetailRow<Plan>(`/api/super-admin/plans/${planId}`, null);
    if (reread.kind !== 'loaded') {
      unconfirmedRef.current = true;
      const guides = reread.kind === 'unavailable' ? [PRICE_CHANGE_UNCONFIRMED_GUIDE, reread.message] : [PRICE_CHANGE_UNCONFIRMED_GUIDE];
      setUnconfirmedMessage([summary, ...guides].join('。'));
      return;
    }
    const reloaded = reread.row;
    // 「済んだか」は route と同じ判定 (Stripe の同期が要れば、価格が同じでも送った間隔の Price ID が入るまで済んでいない。#2107 Y2)
    if (priceChangeAlreadyApplied(planStripeStateOf(reloaded), sent, stripePriceSyncExpectedOf(reloaded))) {
      router.push(historyHref);
      return;
    }
    setPlan(reloaded);
    // 価格は送った値になっているが Price ID がまだ無い (販売開始の Price の登録が済んでいない) か、価格そのものがまだか で文を選ぶ
    const pricesReached = sentPricesMatchPlan(reloaded, sent);
    setError(`${summary}。${pricesReached ? STRIPE_PRICE_NOT_CREATED_GUIDE : PRICE_CHANGE_NOT_APPLIED_GUIDE}`);
  };

  const handleExecute = async () => {
    if (executingRef.current || unconfirmedRef.current) return;
    if (!reason) {
      setError('変更理由を入力してください');
      return;
    }
    if (!plan) {
      setError('プラン情報の読み込みに失敗しました');
      return;
    }
    if (!hasAnyChange) {
      setError('変更がありません');
      return;
    }
    // 月額・年額入力欄は常に現在価格で prefill されているため、変更していない方までそのまま送ると、
    // 変えていない方の Stripe Price も新しく作られ、いまの Price が無効化されてしまう (#1041 round-3 (C2))。
    // 変更されたフィールドのみ送る。月額・年額の両方を変えたときは、両方を送る (1 回のリクエストで
    // 両方を Stripe へ同期できる。#1102)。
    // (monthlyChanged/yearlyChanged はコンポーネント本体で算出済みのものを使う #1041 round-4 (W1))
    // 応答を受け取れなかったときに、読み直したプランと比べるのもこの値 (#2101 X1)
    // #2107 Y2: 送る間隔は toSend (Stripe の同期が要るプランで Price ID がまだ無い間隔は、今と同じ価格でも送る)
    const sent: PriceChangeSentPrices = toSend;
    executingRef.current = true;
    setIsExecuting(true);
    setError('');
    try {
      let res: Response;
      try {
        res = await fetch(`/api/super-admin/plans/${planId}/price-change`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...sent,
            // 価格変更は新規契約のみに適用される (#1102)。API はこの値だけを受け付ける
            applies_to: 'new_only',
            reason,
            effective_at: new Date(effectiveAt).toISOString(),
          }),
        });
      } catch {
        // 応答を受け取れなかった。サーバーが済ませてから切れたこともあるので「失敗しました」とは言わず、プランを読み直して確かめる (#2101 X1)
        throw new AdminActionNoResponseError(PRICE_CHANGE_ACTION, null);
      }
      // ok を先に確かめる (JSON でない 502 を「ネットワークエラー」と見せない。#2093 W7)。本文は 1 回だけ読む
      if (!res.ok) {
        const failureBody = await readFailureBody(res);
        // すでにこの価格 (1 回目が済んでいた・別のタブで済ませた): 済んだものとして履歴へ移る (#2101 X1)
        if (res.status === HTTP_CONFLICT && isPriceUnchangedBody(failureBody)) {
          router.push(historyHref);
          return;
        }
        // 本文に API の文の無い 502 / 503 / 504 は応答を受け取れなかったもの (AdminActionNoResponseError。#2101 X1)
        throw adminActionErrorOfBody(failureBody, res.status, PRICE_CHANGE_ACTION);
      }
      // 成功の応答の本文は使わないので読まない (読めなくても価格の変更は済んでいる)
      router.push(historyHref);
    } catch (err) {
      if (err instanceof AdminActionNoResponseError) {
        await confirmUnconfirmedPriceChange(sent, err.message);
      } else {
        setError(displayableAdminError(err, `${PRICE_CHANGE_ACTION}に失敗しました`));
      }
    } finally {
      executingRef.current = false;
      setIsExecuting(false);
    }
  };

  if (!plan) {
    if (loadError) {
      return (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {loadError}
        </div>
      );
    }
    return <div className="flex items-center justify-center h-48 text-slate-400">読み込み中...</div>;
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* ヘッダー */}
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/super-admin/plans/${planId}`} className="text-slate-400 hover:text-slate-600 transition-colors text-sm">
          ← {plan.display_name}
        </Link>
        <span className="text-slate-300">/</span>
        <h1 className="text-xl font-bold text-slate-900">価格変更</h1>
      </div>

      {/* #2101 X1: 応答を受け取れず、プランも読み直せなかった。済んだか分からないので送信を止め、履歴で確かめさせる (どのステップでも出す) */}
      {unconfirmedMessage && (
        <div
          role="alert"
          data-testid="price-change-unconfirmed"
          className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm"
        >
          <p>{unconfirmedMessage}</p>
          <Link href={historyHref} className="mt-2 inline-block font-medium underline">
            変更履歴を開く
          </Link>
        </div>
      )}

      {/* #1912: 組織のプランの行 (org_*) は組織の段階とは無関係で、組織の利用者の判定に使われない。組織の件数は出さず、注記を出す */}
      {!countsOrganizationsFor(plan) && (
        <p
          data-testid="org-subscription-plan-row-note"
          className="mb-6 bg-slate-50 border border-slate-200 text-slate-600 px-4 py-3 rounded-lg text-xs"
        >
          {ORG_SUBSCRIPTION_PLAN_ROW_NOTE}
        </p>
      )}

      {/* Step 1: 価格入力 + シミュレーション */}
      {step === 1 && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
            <h2 className="text-base font-semibold text-slate-800">現在の価格</h2>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-slate-500">月額:</span>{' '}
                <strong>{plan.monthly_price_jpy != null ? `¥${plan.monthly_price_jpy.toLocaleString()}` : '—'}</strong>
              </div>
              <div>
                <span className="text-slate-500">年額:</span>{' '}
                <strong>{plan.yearly_price_jpy != null ? `¥${plan.yearly_price_jpy.toLocaleString()}` : '—'}</strong>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
            <h2 className="text-base font-semibold text-slate-800">新しい価格</h2>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">新しい月額 (JPY)</label>
                <input
                  type="number"
                  value={newMonthlyPrice}
                  onChange={(e) => {
                    setNewMonthlyPrice(e.target.value);
                    // #1212: 入力を変えたら古いシミュレーション結果は無効 (再シミュレーションを必須にする)
                    setImpact(null);
                  }}
                  // #1212: シミュレーション中に入力を変えると、遅れて届いた古い結果が表示されてしまうため固定する
                  disabled={isSimulating}
                  min="0"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">新しい年額 (JPY)</label>
                <input
                  type="number"
                  value={newYearlyPrice}
                  onChange={(e) => {
                    setNewYearlyPrice(e.target.value);
                    // #2128 V4: 年額も月額 (#1212) と同じく、入力を変えたら古いシミュレーション結果は無効 (再シミュレーションを必須にする)
                    setImpact(null);
                  }}
                  // #2128 V4: 年額もシミュレーション中は固定する (月額と同じ扱い。#1212)
                  disabled={isSimulating}
                  min="0"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
            </div>

            {/* #1102: 価格変更は新規契約のみ。適用範囲は選べない (固定の説明として表示する) */}
            <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm">
              <span className="text-slate-500">適用範囲:</span>{' '}
              <strong className="text-slate-800">{APPLIES_TO_LABEL}</strong>
              <p className="text-xs text-slate-500 mt-1">
                新しい価格は新規の契約にだけ適用されます。既存の契約者の請求額は変わりません。
              </p>
            </div>

            {simulateError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
                {simulateError}
              </div>
            )}

            {/* #2107 Y2: Stripe の Price がまだ無い間隔は、今と同じ価格のままでも送れる (販売開始の Price の登録) */}
            {createsStripePriceOnly && (
              <p data-testid="price-change-creates-stripe-price" className="text-xs text-slate-600">
                {STRIPE_PRICE_MISSING_NOTE}
              </p>
            )}

            {/* #1041 round-4 (W1): 何も変更していない状態で叩けないよう無効化する */}
            {!hasAnyChange && (
              <p className="text-xs text-slate-400">変更がありません (月額または年額を変更してください)</p>
            )}

            {/* #2112 Z1-1: Price ID がまだ無いのに今の価格のままでは送れないときは、Stripe の Price を作れない理由を出す */}
            {stripePriceUnavailableReason && (
              <div
                data-testid="price-change-stripe-price-unavailable"
                className="bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded text-xs"
              >
                <p>{STRIPE_PRICE_UNAVAILABLE_MESSAGES[stripePriceUnavailableReason]}</p>
                {stripePriceUnavailableReason === 'product-missing' && (
                  <Link href={planDetailHref(planId, 'basic')} className="mt-1 inline-block font-medium underline">
                    {OPEN_PLAN_BASIC_TAB_LABEL}
                  </Link>
                )}
              </div>
            )}

            <button
              onClick={handleSimulate}
              disabled={isSimulating || !hasAnyChange}
              className="w-full py-2.5 border-2 border-orange-500 text-orange-600 rounded-lg text-sm font-medium hover:bg-orange-50 transition-colors disabled:opacity-50"
            >
              {isSimulating ? 'シミュレーション中...' : '影響をシミュレーション'}
            </button>

            {/* 影響シミュレーション結果 */}
            {impact && (
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-orange-800 mb-3">影響シミュレーション結果</h3>
                {/* #1102: 価格変更は新規契約のみ。既存契約には影響しない (影響契約数・MRR 変化は出さない) */}
                <p className="text-sm text-orange-800">
                  <strong>既存契約への影響なし</strong>
                  <span className="block text-xs text-orange-600 mt-1">
                    新しい価格は新規契約にのみ適用されます。既存の契約者は現行価格のままです。
                  </span>
                </p>
                <p className="text-xs text-orange-600 mt-2">
                  適用範囲: {APPLIES_TO_LABEL}
                </p>
              </div>
            )}
          </div>

          {impact && (
            <div className="flex justify-end">
              <button
                onClick={() => setStep(2)}
                className="px-6 py-2.5 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors"
              >
                確認ステップへ →
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step 2: 確認・理由入力 → 実行 */}
      {step === 2 && impact && (
        <div className="space-y-6">
          <div className="bg-orange-50 border border-orange-300 rounded-xl p-6">
            <h2 className="text-base font-semibold text-orange-800 mb-4">価格変更の確認</h2>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-orange-600">プラン:</span>
                <strong>{plan.display_name} ({plan.plan_key})</strong>
              </div>
              <div className="flex justify-between">
                <span className="text-orange-600">旧月額 → 新月額:</span>
                {monthlyChanged ? (
                  <strong>
                    ¥{(plan.monthly_price_jpy ?? 0).toLocaleString()} → ¥{Number(newMonthlyPrice).toLocaleString()}
                  </strong>
                ) : monthlySent ? (
                  // #2107 Y2: 価格は変えず、月額の Stripe の Price を作る (Price ID がまだ無い)
                  <strong>¥{(plan.monthly_price_jpy ?? 0).toLocaleString()} (同じ価格。{STRIPE_PRICE_CREATED_NOTE})</strong>
                ) : (
                  <span className="text-slate-400">変更なし (¥{(plan.monthly_price_jpy ?? 0).toLocaleString()})</span>
                )}
              </div>
              {/* #1041 round-4 (W2): 年額の旧 → 新も確認画面に表示する (従来は月額のみ表示され、
                  年額のみ変更した場合に確認画面から変更内容が読み取れなかった) */}
              <div className="flex justify-between">
                <span className="text-orange-600">旧年額 → 新年額:</span>
                {yearlyChanged ? (
                  <strong>
                    ¥{(plan.yearly_price_jpy ?? 0).toLocaleString()} → ¥{Number(newYearlyPrice).toLocaleString()}
                  </strong>
                ) : yearlySent ? (
                  // #2107 Y2: 価格は変えず、年額の Stripe の Price を作る (Price ID がまだ無い)
                  <strong>¥{(plan.yearly_price_jpy ?? 0).toLocaleString()} (同じ価格。{STRIPE_PRICE_CREATED_NOTE})</strong>
                ) : (
                  <span className="text-slate-400">変更なし (¥{(plan.yearly_price_jpy ?? 0).toLocaleString()})</span>
                )}
              </div>
              <div className="flex justify-between">
                <span className="text-orange-600">適用範囲:</span>
                <strong>{APPLIES_TO_LABEL}</strong>
              </div>
              {/* #1102: 価格変更は新規契約のみ。既存契約には影響しない (影響契約数・MRR 変化は出さない) */}
              <div className="flex justify-between">
                <span className="text-orange-600">既存契約への影響:</span>
                <strong>なし (既存の契約者は現行価格のまま)</strong>
              </div>
              <p className="text-xs text-orange-600">
                ※ Stripe 連携が有効な環境では、変更した月額・年額のそれぞれに新しい Stripe 価格 (Price) が作られ、
                同じ期間の旧い Price は新規の申し込みでは選べなくなります。既存の契約者は、これまでの Price のまま請求されます。
              </p>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">変更理由 * (監査ログに記録されます)</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                required
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                placeholder="例: 物価上昇に伴うインフレ調整"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">適用開始日時</label>
              <input
                type="datetime-local"
                value={effectiveAt}
                onChange={(e) => setEffectiveAt(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            {/* #1041 round-4 (W1): Step1 で加えたガードを回避して (例: 戻って価格を
                元に戻してから再度進む) 変更なし状態のまま実行できないようにする */}
            {!hasAnyChange && (
              <div className="bg-slate-50 border border-slate-200 text-slate-500 px-4 py-3 rounded-lg text-sm">
                変更がありません
              </div>
            )}

            <div className="flex gap-3 justify-between">
              <button
                onClick={() => setStep(1)}
                className="px-4 py-2 border border-slate-200 text-slate-700 rounded-lg text-sm hover:bg-slate-50 transition-colors"
              >
                ← 戻る
              </button>
              <button
                onClick={handleExecute}
                disabled={isExecuting || !reason || !hasAnyChange || unconfirmedMessage !== ''}
                className="px-6 py-2 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors disabled:opacity-50"
              >
                {isExecuting ? '実行中...' : createsStripePriceOnly ? CREATE_STRIPE_PRICE_LABEL : EXECUTE_PRICE_CHANGE_LABEL}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
