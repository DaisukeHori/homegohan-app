/**
 * AI 相談の提案 (ai_action_logs の行) の状態の決まり (#2189 W1-a)。
 *
 * 問題:
 *   - 会話の続きの POST の自動実行と、提案のカードの「実行する」(POST /api/ai/consultation/actions/[actionId]/execute) は、
 *     失敗したときに行を failed にしていた。#2183 Z1 で画面は失敗のあとも提案のカードを残すが、実行の API は pending の行しか
 *     探さないので、残したボタンを押しても 404 で、やり直せなかった
 *   - 自動実行で今日の AI の利用回数の上限 (#1149) に当たったときも failed にしていた (手の実行は pending のまま残す)
 *   - 相談を開き直すと、GET が保存した提案 (proposed_actions) をそのまま返し、実行済みの提案のカードがまた出ていた
 *
 * 決まり:
 *   - 成功したら executed。今日の上限で止めたら pending のまま (明日もう一度実行できる。同意が無くて止めたときと同じ)
 *   - 失敗したら pending のまま残し、残したボタンで本当にやり直せるようにする。ただし、途中まで書いてから失敗しうる種類
 *     (AI_ACTION_TYPES_NOT_RETRYABLE_AFTER_FAILURE) と、対応していない種類と、やり直しても直らない失敗 (実行の結果の
 *     notRetryable。権限・検査・空の入力。#2195 V2。AI が作った値の誤り (22P02・22007・22008・23503。
 *     src/lib/ai/consultation-action-executor.ts の POSTGRES_AI_VALUE_ERROR_CODES) も含む) は failed にし、画面は「実行する」を出さずに
 *     「もう一度頼んでください」の案内を出す (AI_PROPOSED_ACTION_NOT_EXECUTABLE_GUIDE)
 *   - 実行している間は approved (実行中の印)。pending から approved への書き換えを条件つきの 1 文で行い、書けた 1 本だけが
 *     実行する (2 つの画面から同時に押しても二重に実行しない)。実行が終わったら上の決まりの状態に書き換える
 *   - GET は、行の状態から提案のカードを出すかと「実行する」を出すかを決める (proposedActionViewOf)。行が実行中の印のまま
 *     (実行中か、書き戻せなかった) のカードは「実行できたかを確かめられない」の案内 (AI_PROPOSED_ACTION_UNCONFIRMED_GUIDE) にし、
 *     頼み直しを勧めない (#2195 V2。#2201 U3 で「実行中か実行済み」から改めた: 書き戻せなかったのは、実行の結果が失敗のときや
 *     今日の上限で実行しなかったときもあるので、「実行済み」とも読める文にしない)
 *   - 実行のあとに行を書き戻せなかった (2 回とも失敗した) ときは、その場の応答も同じ「確かめられない」の理由
 *     (PROPOSED_ACTION_NOT_EXECUTABLE_REASON.unconfirmed) にする (#2201 U3。以前はその場では「もう一度頼んでください」、
 *     開き直すと「実行中か実行済み」で、文が食い違っていた)
 *
 * このファイルはブラウザでも読み込む (サーバーの依存を import しない。型も import しない: 実行の本体
 * (src/lib/ai/consultation-action-executor.ts) は AI へ送るコードに届くので、画面の部品からたどれる形にしない。
 * tests/ai-consent-enforcement.test.ts の棚卸しが import をたどって確かめる)。
 */
/** ai_action_logs.status の値 (DB の ai_action_logs_status_check と同じ 5 つ) */
export const AI_ACTION_LOG_STATUS = {
  /** 実行を待っている (自動実行が失敗した・上限や同意で止めた)。「実行する」で実行できる */
  pending: 'pending',
  /** 実行中 (pending から条件つきで書き換えた 1 本だけが実行する) */
  running: 'approved',
  /** 実行できた */
  executed: 'executed',
  /** 失敗し、やり直せない (途中まで書いた可能性がある種類・対応していない種類・やり直しても直らない失敗 (notRetryable)) */
  failed: 'failed',
  /** 利用者が提案を断った */
  rejected: 'rejected',
} as const;

export type AiActionLogStatus = (typeof AI_ACTION_LOG_STATUS)[keyof typeof AI_ACTION_LOG_STATUS];

/**
 * 失敗したあとにやり直させない種類 (failed にし、画面は「実行する」を出さずに案内を出す)。種類 → 理由。
 *
 * 献立の生成の 3 種類は、生成の依頼 (weekly_menu_requests) を作ってから Edge Function を呼ぶ。呼び出しが時間切れ・5xx で
 * 失敗しても、Edge Function の側は動き続けて献立 (planned_meals) を書いていることがある (invokeGenerateMenuV4WithRetry は
 * 時間切れのあとも呼び出しを止めず、同じ依頼で最大 3 回呼ぶ)。planned_meals には「1 日の 1 区分に 1 行」の一意の制約が無いので、
 * やり直すと同じ食事の枠に献立が 2 つできうる。数えた 1 回 (#1149) も戻していないので、やり直すと 2 回数える。
 * 二重に書かないことを確かめられないので、やり直させない (利用者には AI にもう一度頼んでもらう)。
 *
 * ほかの種類は、途中で失敗しても二重に書かない (src/lib/ai/consultation-action-executor.ts の各 case):
 *   - 書き込みが最後の 1 文で、失敗したら何も書いていない: add_to_shopping_list (行の一括 insert)・add_pantry_item・set_health_goal
 *     (insert 1 文)・like_recipe (確かめてから insert 1 文)。ただし add_to_shopping_list・add_pantry_item・set_health_goal は、
 *     DB に書けたのに応答が失われて失敗になったとき (通信の切れ) は pending に戻るので、押し直すと同じ行をもう 1 つ insert しうる
 *     (起きる頻度がごく低いので、やり直させない種類にはしない)
 *   - 同じ値で書き直すだけ (何度実行しても結果が同じ): update_meal・complete_meal・update_shopping_item・check_shopping_item・
 *     update_pantry_item・update_nutrition_target (user_id の upsert)・update_health_goal・add_health_record
 *     (user_id, record_date の upsert)・update_health_record・update_profile_preferences
 *   - 消すだけ (消えていれば「見つからない」の失敗で何も書かない): delete_meal・delete_shopping_item・delete_pantry_item・delete_health_goal
 *   - 読むだけ: suggest_recipe
 *   - コレクションは名前の upsert、レシピの追加は「まだ入っていないときだけ足す」1 文の関数: add_recipe_to_collection
 */
export const AI_ACTION_TYPES_NOT_RETRYABLE_AFTER_FAILURE: ReadonlyMap<string, string> = new Map([
  ['generate_day_menu', '献立の生成は、呼び出しが失敗しても Edge Function が献立を書いていることがあり、やり直すと同じ枠に二重に書きうる'],
  ['generate_week_menu', '献立の生成は、呼び出しが失敗しても Edge Function が献立を書いていることがあり、やり直すと同じ枠に二重に書きうる'],
  ['generate_single_meal', '献立の生成は、呼び出しが失敗しても Edge Function が献立を書いていることがあり、やり直すと同じ枠に二重に書きうる'],
]);

/**
 * 実行の結果のうち、行の状態を決めるのに使う部分 (src/lib/ai/consultation-action-executor.ts の
 * ConsultationActionExecutionResult の success・unknownActionType・aiDailyLimit と同じ意味)
 */
export interface ConsultationActionRunForStatus {
  success: boolean;
  unknownActionType?: boolean;
  /** 今日の AI の利用回数の上限 (#1149) で実行しなかったとき (中身は見ない。あるかどうかだけ) */
  aiDailyLimit?: unknown;
  /**
   * やり直しても直らない失敗 (権限が無い・対象が無い・値が検査に落ちた・入力が空)。何度押しても同じ失敗が返るので、
   * やり直せる種類でも failed にし、画面は「実行する」を出さずに案内を出す (#2195 V2)
   */
  notRetryable?: boolean;
}

/** 実行が終わったあとの行の状態 (実行中の印 approved から書き換える先) */
export type AiActionLogStatusAfterRun =
  | typeof AI_ACTION_LOG_STATUS.executed
  | typeof AI_ACTION_LOG_STATUS.failed
  | typeof AI_ACTION_LOG_STATUS.pending;

/** 失敗したあと (結果が失敗・実行の中で例外) の状態: やり直せる種類は pending、やり直させない種類は failed */
export function aiActionLogStatusAfterFailure(actionType: string): AiActionLogStatusAfterRun {
  return AI_ACTION_TYPES_NOT_RETRYABLE_AFTER_FAILURE.has(actionType) ? AI_ACTION_LOG_STATUS.failed : AI_ACTION_LOG_STATUS.pending;
}

/** 実行の結果から、行の状態を決める */
export function aiActionLogStatusAfterRun(actionType: string, run: ConsultationActionRunForStatus): AiActionLogStatusAfterRun {
  // 対応していない種類は、何度実行しても実行できない
  if (run.unknownActionType) return AI_ACTION_LOG_STATUS.failed;
  if (run.success === true) return AI_ACTION_LOG_STATUS.executed;
  // 今日の上限で止めた (実行していない): 明日もう一度実行できる
  if (run.aiDailyLimit) return AI_ACTION_LOG_STATUS.pending;
  // やり直しても直らない失敗 (権限・検査・空の入力) は、やり直せる種類でも残さない (#2195 V2)
  if (run.notRetryable === true) return AI_ACTION_LOG_STATUS.failed;
  return aiActionLogStatusAfterFailure(actionType);
}

/**
 * 提案のカードで「実行する」を出さないときの理由 (案内の文を分ける。#2195 V2)。
 * 応答の proposedActionNotExecutableReason (GET・会話の続きの POST) と notExecutableReason (実行の API) に入る
 */
export const PROPOSED_ACTION_NOT_EXECUTABLE_REASON = {
  /** 失敗してやり直せない・記録が無い (実行していない)。もう一度 AI に頼んでもらう */
  failed: 'failed',
  /** 実行中か実行済み (別の画面・自動実行が実行した・いま実行の印を取った。行が executed)。頼み直すと二重になりうる */
  runningOrDone: 'runningOrDone',
  /**
   * 実行できたかを確かめられない (行が実行中の印 approved のまま: 実行している最中か、実行のあとに状態を書き戻せなかった。
   * #2201 U3)。実行したとも、していないとも言い切らず、頼み直しも勧めない (頼み直すと二重になりうる)
   */
  unconfirmed: 'unconfirmed',
} as const;

export type ProposedActionNotExecutableReason =
  (typeof PROPOSED_ACTION_NOT_EXECUTABLE_REASON)[keyof typeof PROPOSED_ACTION_NOT_EXECUTABLE_REASON];

/** 値が「実行する」を出さない理由のどれかか (応答の本文を読むときに使う) */
export function isProposedActionNotExecutableReason(value: unknown): value is ProposedActionNotExecutableReason {
  return (Object.values(PROPOSED_ACTION_NOT_EXECUTABLE_REASON) as readonly unknown[]).includes(value);
}

/**
 * 実行のあとに「実行する」を出さないときの理由 (実行の API の応答・会話の続きの POST の自動実行)。
 * 行を書き戻せなかった (実行中の印のまま) なら unconfirmed (開き直したときの GET と同じ理由・同じ文)、
 * 書き戻せた (failed にした・行が無い) なら failed (#2201 U3)
 */
export function notExecutableReasonAfterRun(writeBackFailed: boolean): ProposedActionNotExecutableReason {
  return writeBackFailed ? PROPOSED_ACTION_NOT_EXECUTABLE_REASON.unconfirmed : PROPOSED_ACTION_NOT_EXECUTABLE_REASON.failed;
}

/** 提案のカードの出し方 */
export type ProposedActionView =
  /** カードを出さない (実行できた・断った) */
  | 'hidden'
  /** カードと「実行する」を出す (行が pending) */
  | 'executable'
  /** カードは出すが「実行する」は出さず、「もう一度頼んでください」の案内を出す (やり直せない失敗・行が無い) */
  | 'notExecutable'
  /** カードは出すが「実行する」は出さず、「実行できたかを確かめられない」の案内を出す (行が実行中の印 approved のまま。#2201 U3) */
  | 'unconfirmed';

/**
 * メッセージの提案に付いた行の状態 (ふつうは 1 行) から、提案のカードの出し方を決める。
 * 行が無い (記録に失敗した) ときは、実行の API が見つけられないので「実行する」を出さない。
 * 行が実行中の印 (approved) のまま残っているのは、実行している最中か、実行のあとに状態を書き戻せなかった (関数の時間切れ・
 * 書き込みの失敗) とき。成功していることがあるので「もう一度頼んでください」とは出さない (頼み直すと献立を二重に作りうる)。
 * 失敗していることも、今日の上限で実行しなかったこともあるので「実行済み」とも出さない (#2201 U3)
 */
export function proposedActionViewOf(statuses: readonly string[]): ProposedActionView {
  if (statuses.some((s) => s === AI_ACTION_LOG_STATUS.executed || s === AI_ACTION_LOG_STATUS.rejected)) return 'hidden';
  if (statuses.includes(AI_ACTION_LOG_STATUS.pending)) return 'executable';
  if (statuses.includes(AI_ACTION_LOG_STATUS.running)) return 'unconfirmed';
  return 'notExecutable';
}

/** カードの出し方から、「実行する」を出さない理由 (出すとき・カードを出さないときは null) */
export function proposedActionNotExecutableReasonOfView(view: ProposedActionView): ProposedActionNotExecutableReason | null {
  if (view === 'unconfirmed') return PROPOSED_ACTION_NOT_EXECUTABLE_REASON.unconfirmed;
  if (view === 'notExecutable') return PROPOSED_ACTION_NOT_EXECUTABLE_REASON.failed;
  return null;
}

/**
 * 断る API (DELETE /api/ai/consultation/actions/[actionId]/execute) の 404 の本文に添える、カードの見え方 (#2295)。
 * 404 は、行が断られた (別の画面で断った)・実行済み・失敗・実行中の印のまま・行が無い、のどれでも返る。画面が「実行中か実行済み」と
 * 決め打ちしないよう、相談を開き直したときの GET (proposedActionViewOf) と同じ見え方を添える:
 *   - hidden (断った・実行済み): proposedActionHidden: true (画面はカードを閉じる)
 *   - unconfirmed (実行中の印のまま): notExecutableReason: 'unconfirmed'
 *   - notExecutable (失敗・行が無い): notExecutableReason: 'failed'
 *   - executable (間に pending に戻った): 何も添えない (画面はカードを残し、断れなかった文を出す)
 */
export interface ProposedActionRejectNotFoundFields {
  proposedActionHidden?: true;
  notExecutableReason?: ProposedActionNotExecutableReason;
}

/** カードの見え方から、断る API の 404 の本文に添える値を決める (#2295) */
export function proposedActionRejectNotFoundFieldsOfView(view: ProposedActionView): ProposedActionRejectNotFoundFields {
  if (view === 'hidden') return { proposedActionHidden: true };
  const reason = proposedActionNotExecutableReasonOfView(view);
  return reason ? { notExecutableReason: reason } : {};
}

/**
 * 実行の API (POST /api/ai/consultation/actions/[actionId]/execute) の 400 / 404 の本文に添える値 (#2299)。
 * 断った提案 (proposedActionRejectedOnlyOf) には proposedActionHidden: true を添え (画面はカードを閉じる。相談を開き直したときの
 * GET の hidden と同じ)、それ以外は「実行する」を出さない理由 (notExecutableReason) を添える (理由が無いときは何も添えない)
 */
export interface ProposedActionExecuteNotExecutableFields {
  proposedActionHidden?: true;
  notExecutableReason?: ProposedActionNotExecutableReason;
}

/**
 * 1 つのメッセージに付いた行の状態たちが「断った提案」か (#2299): rejected があり、executed も approved (実行中の印) も無い。
 * executed があるときは、頼み直すと二重になるので「実行中か実行済み」の案内を残す (#2195 V2)。approved があるときは、
 * 実行できたかを確かめられない (#2201 U3) ので、カードを閉じない
 */
export function proposedActionRejectedOnlyOf(statuses: readonly unknown[]): boolean {
  return (
    statuses.includes(AI_ACTION_LOG_STATUS.rejected) &&
    !statuses.includes(AI_ACTION_LOG_STATUS.executed) &&
    !statuses.includes(AI_ACTION_LOG_STATUS.running)
  );
}

/**
 * 実行の API の 404 (メッセージ ID で pending の行が無い) と 400 (読んだ時点で pending でない) の本文に添える値 (#2299)。
 * statuses はそのメッセージの本人の行の状態たち (400 は読んだ 1 行の状態だけ)。読めなかったときは null (何も添えない)。
 * 断った提案は proposedActionHidden: true、それ以外は今までの理由 (proposedActionNotExecutableReasonOfStatuses。行が無いときは何も添えない)
 */
export function proposedActionExecuteNotExecutableFieldsOfStatuses(
  statuses: readonly unknown[] | null,
): ProposedActionExecuteNotExecutableFields {
  if (!statuses) return {};
  if (proposedActionRejectedOnlyOf(statuses)) return { proposedActionHidden: true };
  const reason = proposedActionNotExecutableReasonOfStatuses(statuses);
  return reason ? { notExecutableReason: reason } : {};
}

/**
 * 実行の API の 400 (実行中の印の取得 (claim) が 0 行。読んでから取るまでの間に先を越された) の本文に添える値 (#2299)。
 * statuses は claim のあとに読み直した、そのメッセージの本人の行の状態たち (読めなかったときは null)。
 * 間に別の画面が断った (断った提案) なら proposedActionHidden: true、それ以外 (実行中の印・実行済み・読めない など) は
 * 今までと同じ runningOrDone (別の画面・自動実行が先に取った)
 */
export function proposedActionExecuteClaimLostFieldsOfStatuses(
  statuses: readonly unknown[] | null,
): ProposedActionExecuteNotExecutableFields {
  if (statuses && proposedActionRejectedOnlyOf(statuses)) return { proposedActionHidden: true };
  return { notExecutableReason: PROPOSED_ACTION_NOT_EXECUTABLE_REASON.runningOrDone };
}

/**
 * 実行の API の 400 / 404 の本文が、カードを閉じる (proposedActionHidden: true) ことを示しているか (#2299)。
 * 許した値 (true) だけを通す (proposedActionRejectNotFoundOutcomeOfBody と同じ読み方)
 */
export function isProposedActionHiddenBody(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { proposedActionHidden?: unknown }).proposedActionHidden === true;
}

/** 断る API の 404 の本文から読んだ、画面の出し方 (#2295) */
export type ProposedActionRejectNotFoundOutcome =
  /** カードを閉じる (断った・実行済み。開き直したときの GET と同じ) */
  | { kind: 'hidden' }
  /** カードは残し、「実行する」を出さずに理由の案内を出す */
  | { kind: 'notExecutable'; reason: ProposedActionNotExecutableReason }
  /** 何も添えられていない・読めない: カードを残し、断れなかった文を出す */
  | { kind: 'unknown' };

/**
 * 断る API の 404 の本文を読む (#2295)。許した値 (proposedActionHidden が true・notExecutableReason が理由のどれか) だけを通し、
 * それ以外 (本文が無い・JSON でない・値が違う) は unknown
 */
export function proposedActionRejectNotFoundOutcomeOfBody(body: unknown): ProposedActionRejectNotFoundOutcome {
  if (!body || typeof body !== 'object') return { kind: 'unknown' };
  const fields = body as { proposedActionHidden?: unknown; notExecutableReason?: unknown };
  if (fields.proposedActionHidden === true) return { kind: 'hidden' };
  if (isProposedActionNotExecutableReason(fields.notExecutableReason)) {
    return { kind: 'notExecutable', reason: fields.notExecutableReason };
  }
  return { kind: 'unknown' };
}

/** 提案のカードで「実行する」の代わりに出す案内 (やり直せない失敗・記録が無い) */
export const AI_PROPOSED_ACTION_NOT_EXECUTABLE_GUIDE = 'この提案はここからは実行できません。もう一度 AI に頼んでください。';

/** 提案のカードで「実行する」の代わりに出す案内 (実行中か実行済み。頼み直すと二重になりうるので、頼み直しを勧めない) */
export const AI_PROPOSED_ACTION_RUNNING_OR_DONE_GUIDE = 'この提案は実行中か実行済みです。';

/**
 * 提案のカードで「実行する」の代わりに出す案内 (行が実行中の印のまま。実行できたかを確かめられない。#2201 U3)。
 * 実行したとも、していないとも言い切らず (実行の結果が失敗のとき・今日の上限で実行しなかったときにも出る)、頼み直しも勧めない
 */
export const AI_PROPOSED_ACTION_UNCONFIRMED_GUIDE =
  'この提案を実行できたかを確かめられませんでした。しばらくしてから相談を開き直してください。';

/** 「実行する」を出さない理由から、案内の文を引く (理由が分からないときは「もう一度頼んでください」) */
export function aiProposedActionNotExecutableGuideOf(reason: ProposedActionNotExecutableReason | undefined): string {
  if (reason === PROPOSED_ACTION_NOT_EXECUTABLE_REASON.runningOrDone) return AI_PROPOSED_ACTION_RUNNING_OR_DONE_GUIDE;
  if (reason === PROPOSED_ACTION_NOT_EXECUTABLE_REASON.unconfirmed) return AI_PROPOSED_ACTION_UNCONFIRMED_GUIDE;
  return AI_PROPOSED_ACTION_NOT_EXECUTABLE_GUIDE;
}

/**
 * ai_action_logs の状態から、実行の API が「実行する」を出さない理由を決める (400 ALREADY_PROCESSED の本文に入れる)。
 * 実行済みは runningOrDone、実行中の印のまま (実行中か、書き戻せなかった) は GET と同じ unconfirmed (#2201 U3)、
 * それ以外 (失敗・断った・pending でない何か) は failed
 */
export function proposedActionNotExecutableReasonOfStatus(status: unknown): ProposedActionNotExecutableReason {
  if (status === AI_ACTION_LOG_STATUS.executed) return PROPOSED_ACTION_NOT_EXECUTABLE_REASON.runningOrDone;
  if (status === AI_ACTION_LOG_STATUS.running) return PROPOSED_ACTION_NOT_EXECUTABLE_REASON.unconfirmed;
  return PROPOSED_ACTION_NOT_EXECUTABLE_REASON.failed;
}

/**
 * 1 つのメッセージに付いた行の状態たちから、実行の API が「実行する」を出さない理由を 1 つに決める
 * (実行済み > 実行中の印のまま > それ以外 の順。どれかが実行済みなら頼み直すと二重になる)。行が無いときは null
 */
export function proposedActionNotExecutableReasonOfStatuses(
  statuses: readonly unknown[],
): ProposedActionNotExecutableReason | null {
  if (statuses.length === 0) return null;
  const reasons = statuses.map(proposedActionNotExecutableReasonOfStatus);
  for (const reason of [PROPOSED_ACTION_NOT_EXECUTABLE_REASON.runningOrDone, PROPOSED_ACTION_NOT_EXECUTABLE_REASON.unconfirmed]) {
    if (reasons.includes(reason)) return reason;
  }
  return PROPOSED_ACTION_NOT_EXECUTABLE_REASON.failed;
}

/**
 * 自動実行の提案を ai_action_logs に記録できなかったときの結果の文 (実行していない)。
 * 行が無いので、カードの「実行する」からも実行できない
 */
export const AI_CONSULTATION_ACTION_LOG_INSERT_FAILED_MESSAGE = '提案を記録できなかったため、実行しませんでした。もう一度 AI に頼んでください。';

/**
 * 提案のカードの「断る」(DELETE /api/ai/consultation/actions/[actionId]/execute) が断れなかったときに会話へ足す文 (#2295)。
 * 応答が失敗 (500・401・応答が読めない・通信の失敗) のときと、404 の本文にカードの見え方が添えられていないとき
 * (間に pending に戻った・行の状態を読めなかった) に出す。カードは残すので、もう一度断れる。
 * 応答の本文 (error) の文面は画面に出さず、いつもこの固定の文にする
 */
export const AI_PROPOSED_ACTION_REJECT_FAILED_MESSAGE = '提案を断れませんでした。時間をおいてもう一度お試しください。';
