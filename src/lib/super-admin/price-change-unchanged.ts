/**
 * 価格の変更 (POST /api/super-admin/plans/{id}/price-change) の「送られた価格が今の価格と同じ」の判定と、その 409 の code・文 (#2101 X1)
 *
 * 以前は、価格の変更の応答が切れた (fetch の reject・本文の無い 502 / 504) あとに運営が押し直すと、1 回目で済んでいても
 * 同じ金額でもう一度 Stripe に新しい Price が作られ、1 回目に作った Price が無効化され、plan_price_history と監査に 2 行目が入った。
 * いまは route が予約 (begin_plan_price_change) でロックの下で読んだ今の価格と送られた価格を比べ、送られた価格がすべて今の価格と同じなら、
 * Stripe も DB も触らず、監査も書かずに 409 OP_PRICE_UNCHANGED を返す (priceChangeAlreadyApplied)。
 * ただし Stripe の同期が要る環境で、送った間隔の Stripe Price ID がまだ無い (NULL) ときは、同じ価格でも続ける。
 * 有料プランの販売開始の手順 (docs/design/billing/03-paid-plans-and-iap.md §12 の順 3) は、migration が入れた価格のまま
 * この API に同じ値を渡して Stripe の Price を作り、ID を入れるため (1 回目でその ID が入るので、押し直しは 409 になる)。
 * 画面 (src/app/super-admin/plans/[id]/price-change/page.tsx) は、応答を受け取れなかったときにプランを読み直し、同じ判定で
 * 「送った価格になっている = 済んだ」を決める。409 OP_PRICE_UNCHANGED も済んだものとして履歴へ移る。
 *
 * #2107 Y2・Y8: 判定は間隔 (月額・年額) ごとに行う (pendingPriceChange)。今と同じ価格で、Stripe の同期が要らないか Price ID が入っている間隔は
 * 「もう済んでいる」ので、送られても外す。route は外した残りだけを Stripe と DB に渡し (片方の間隔だけ ID が無いプランに両方を送っても、
 * ID のある間隔の Price を作り直して無効化しない)、残りが無ければ 409 OP_PRICE_UNCHANGED にする。画面も同じ判定で送る間隔を決めるので、
 * Stripe の同期が要るプラン (GET /api/super-admin/plans/{id} の stripe_price_sync_expected) で Price ID がまだ無い間隔は、
 * 今と同じ価格のまま送れる (販売開始の Price の登録)。「Stripe の同期が要るか」は route と GET の両方が isStripePriceSyncExpected で決める。
 *
 * このファイルはブラウザからも読むので、サーバー専用のものを import しない。
 */

/** 409: 送られた価格がすべて今の価格と同じ (Stripe も DB も触らず、監査も書かない) */
export const PRICE_UNCHANGED_CODE = 'OP_PRICE_UNCHANGED';

/** 409 OP_PRICE_UNCHANGED の文 */
export const PRICE_UNCHANGED_MESSAGE = 'すでにこの価格です。履歴で確かめてください';

/** プランの今の価格 (subscription_plans の月額・年額) */
export interface PlanCurrentPrices {
  monthly_price_jpy: number | null;
  yearly_price_jpy: number | null;
}

/** 価格の変更で送る価格 (変えない方は null か省略) */
export interface PriceChangeSentPrices {
  new_monthly_price_jpy?: number | null;
  new_yearly_price_jpy?: number | null;
}

/**
 * 送った価格が、プランの今の価格にすべてなっているか。
 * 送った方 (null でない方) だけを比べる。どちらも送っていなければ false (変更が無いものを「済んだ」とは言わない)
 */
export function sentPricesMatchPlan(plan: PlanCurrentPrices, sent: PriceChangeSentPrices): boolean {
  const monthly = sent.new_monthly_price_jpy ?? null;
  const yearly = sent.new_yearly_price_jpy ?? null;
  if (monthly === null && yearly === null) return false;
  return (monthly === null || monthly === plan.monthly_price_jpy) && (yearly === null || yearly === plan.yearly_price_jpy);
}

/** route が予約のときにロックの下で読んだプランの値のうち、判定に使うもの (今の価格と Stripe Price ID) */
export interface PlanCurrentPricesWithStripe extends PlanCurrentPrices {
  /** 月額の Stripe Price ID (#1102) */
  stripe_price_id: string | null;
  /** 年額の Stripe Price ID (#1102) */
  stripe_yearly_price_id: string | null;
}

/**
 * Stripe の同期が要るか (route が Edge Function stripe-price-sync を呼んで Price を作るか)。
 * Stripe の鍵 (STRIPE_SECRET_KEY) があり、プランに Stripe の商品 (stripe_product_id) があるときだけ true。
 * 鍵が無い・商品が無いときは mock (DB だけを書く)。route と GET /api/super-admin/plans/{id} の stripe_price_sync_expected が同じこの判定を使う。
 * 鍵の値はここで受け取るだけで返さない (このファイルはブラウザからも読むので、process.env はサーバーの呼び出し側で読んで渡す)
 */
export function isStripePriceSyncExpected(stripeSecretKey: string | null | undefined, stripeProductId: string | null | undefined): boolean {
  return Boolean(stripeSecretKey && stripeProductId);
}

/**
 * 1 つの間隔がもう済んでいるか: 送った価格が今の価格と同じで、Stripe の同期が要らないか、その間隔の Stripe Price ID が入っている。
 * 送っていない間隔 (null) は済んでいるとも済んでいないとも言わないので、呼び出し側で除く
 */
function intervalAlreadyApplied(sentPrice: number, currentPrice: number | null, stripePriceId: string | null, stripeSyncExpected: boolean): boolean {
  if (sentPrice !== currentPrice) return false;
  return !stripeSyncExpected || Boolean(stripePriceId);
}

/** 価格の変更で、まだ済んでいない間隔の価格 (済んでいる間隔・送っていない間隔は null) */
export interface PendingPriceChange {
  new_monthly_price_jpy: number | null;
  new_yearly_price_jpy: number | null;
}

/**
 * 送った価格のうち、まだ済んでいない間隔だけを残す (#2107 Y2・Y8)。
 * 今と違う価格の間隔は残す。今と同じ価格の間隔は、Stripe の同期が要り、その間隔の Stripe Price ID がまだ無いときだけ残す
 * (販売開始の Price の登録。docs/design/billing/03-paid-plans-and-iap.md §12 の順 3)。ほかは外す (null)。
 * route はこの残りだけを Stripe と DB と監査に渡す。画面は入力した価格をこれに通して、送る間隔を決める
 */
export function pendingPriceChange(
  plan: PlanCurrentPricesWithStripe,
  sent: PriceChangeSentPrices,
  stripeSyncExpected: boolean,
): PendingPriceChange {
  const monthly = sent.new_monthly_price_jpy ?? null;
  const yearly = sent.new_yearly_price_jpy ?? null;
  return {
    new_monthly_price_jpy:
      monthly !== null && !intervalAlreadyApplied(monthly, plan.monthly_price_jpy, plan.stripe_price_id, stripeSyncExpected) ? monthly : null,
    new_yearly_price_jpy:
      yearly !== null && !intervalAlreadyApplied(yearly, plan.yearly_price_jpy, plan.stripe_yearly_price_id, stripeSyncExpected) ? yearly : null,
  };
}

/**
 * route の判定: 送られた価格の変更はもう済んでいるか (Stripe も DB も触らず 409 OP_PRICE_UNCHANGED にするか)。
 * 送った間隔がどれもまだ済んでいない間隔として残らない (pendingPriceChange が両方 null) とき true。
 * つまり送った価格がすべて今の価格と同じで、かつ Stripe の同期が要らないか、送った間隔の Stripe Price ID がどれも入っているとき。
 * 何も送っていなければ false (変更が無いものを「済んだ」とは言わない)
 */
export function priceChangeAlreadyApplied(
  plan: PlanCurrentPricesWithStripe,
  sent: PriceChangeSentPrices,
  stripeSyncExpected: boolean,
): boolean {
  if ((sent.new_monthly_price_jpy ?? null) === null && (sent.new_yearly_price_jpy ?? null) === null) return false;
  const pending = pendingPriceChange(plan, sent, stripeSyncExpected);
  return pending.new_monthly_price_jpy === null && pending.new_yearly_price_jpy === null;
}

/** 失敗の応答の本文 ({ error: { code } }) が 409 OP_PRICE_UNCHANGED のものか */
export function isPriceUnchangedBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === PRICE_UNCHANGED_CODE;
}
