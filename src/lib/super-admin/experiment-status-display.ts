/**
 * A/B テストの画面 (一覧 /super-admin/experiments・詳細 /super-admin/experiments/[id]) で、実験の状態を運営に見せるときの文 (#2064)。
 *
 * 状態は DB の値 (draft / running / completed / cancelled) のまま見せず、画面の表示名 (下書き・実行中・完了・中止) で出す。
 * 状態の変更 (開始・完了・中止) が 409 で断られたとき (遷移表に無い変更 OP_EXPERIMENT_INVALID_TRANSITION・
 * 読んでから書くまでに別の操作が状態を変えた CONFLICT_STALE_DATA) は、画面の状態が古い。画面が自分で実験を読み直し、
 * 読み直した旨と今の状態を日本語の文で出す (route の文は DB の値の英字の状態名を埋めるので出さない)。
 */
import { STALE_DATA_ERROR_CODE, STALE_DATA_HTTP_STATUS, extractApiErrorCode } from '@/lib/admin/api-error-message';
import {
  NO_RESPONSE_LIST_RELOADED_GUIDE,
  NO_RESPONSE_LIST_RELOAD_FAILED_GUIDE,
  NO_RESPONSE_STATE_RELOAD_FAILED_GUIDE,
  statusChangeNoResponseMessage,
  statusChangeNoResponseSummary,
} from '@/lib/super-admin/status-change-no-response';
import {
  EXPERIMENT_INVALID_TRANSITION_ERROR_CODE,
  isExperimentStatus,
  type ExperimentStatus,
} from '@/lib/super-admin/experiments-schemas';

/** 状態の画面の表示名 (一覧のバッジ・詳細のバッジ・読み直したときの文で同じ名前を使う) */
export const EXPERIMENT_STATUS_LABELS: Readonly<Record<ExperimentStatus, string>> = {
  draft: '下書き',
  running: '実行中',
  completed: '完了',
  cancelled: '中止',
};

/** DB の CHECK の外の値 (来ないはず) を見せるときの表示名。英字の値をそのまま見せない */
export const UNKNOWN_EXPERIMENT_STATUS_LABEL = '不明な状態';

/** 状態の画面の表示名。知らない値なら UNKNOWN_EXPERIMENT_STATUS_LABEL */
export function experimentStatusLabel(status: string): string {
  return isExperimentStatus(status) ? EXPERIMENT_STATUS_LABELS[status] : UNKNOWN_EXPERIMENT_STATUS_LABEL;
}

/** 画面のボタンが送る状態 (遷移表の行き先と同じ 3 つ。draft へは戻さない) */
export type ExperimentStatusChangeTarget = Exclude<ExperimentStatus, 'draft'>;

/** 詳細の「実験開始」・「完了」・「中止」を押したときの確認の文 (英字の状態名を出さない) */
export const EXPERIMENT_STATUS_CHANGE_CONFIRM_MESSAGES: Readonly<Record<ExperimentStatusChangeTarget, string>> = {
  running: 'この実験を開始しますか？',
  completed: 'この実験を完了にしますか？',
  cancelled: 'この実験を中止しますか？',
};

/** 状態の変更が 409 で断られた理由のコード (どちらも画面の状態が古いので、読み直す) */
const EXPERIMENT_STATUS_CONFLICT_CODES: readonly string[] = [EXPERIMENT_INVALID_TRANSITION_ERROR_CODE, STALE_DATA_ERROR_CODE];

/**
 * 状態の変更の応答が「画面の状態が古い」409 か (遷移表に無い変更・読んでから書くまでに別の操作が状態を変えた)。
 * どちらも、別のタブ・別の運営が先に状態を変えたときに起きる
 */
export function isExperimentStatusConflict(status: number, body: unknown): boolean {
  const code = extractApiErrorCode(body);
  return status === STALE_DATA_HTTP_STATUS && code !== null && EXPERIMENT_STATUS_CONFLICT_CODES.includes(code);
}

/** 詳細: 409 のあとに実験を読み直したときの文 (今の状態を表示名で添える) */
export function experimentStaleReloadedMessage(currentStatus: string): string {
  return `別の操作で実験の状態が先に変わっていました（今の状態: ${experimentStatusLabel(currentStatus)}）。最新の内容を読み込み直したので、状態を確かめてから、もう一度操作してください`;
}

/** 詳細: 409 のあとの読み直しに失敗したときの文 (「再試行」を出す) */
export const EXPERIMENT_STALE_RELOAD_FAILED_MESSAGE =
  '別の操作で実験の状態が先に変わっていました。最新の内容を読み込み直せませんでした。「再試行」で読み込み直してから、もう一度操作してください';

/** 詳細: 読み直しが 404 (読み直しの間に実験が消えた) で断られたときの文。読み込み直しても変わらないので「再試行」は出さない */
export const EXPERIMENT_NOT_FOUND_ON_RELOAD_MESSAGE = '実験が見つかりません。一覧に戻って確かめてください';

/** 一覧: 409 のあとに一覧を読み直し、その実験があったときの文 */
export function experimentListStaleReloadedMessage(name: string, currentStatus: string): string {
  return `別の操作で「${name}」の状態が先に変わっていました（今の状態: ${experimentStatusLabel(currentStatus)}）。一覧を読み込み直したので、状態を確かめてから、もう一度操作してください`;
}

/**
 * 一覧: 409 のあとに読み直した一覧にその実験が無く、詳細の API も 404 (実験が無い) だったときの文。
 * 一覧はページで送るので、一覧 (表示しているページ) に無いだけでは出さない (詳細の API で無いと確かめてから出す。#2107 Y9)
 */
export function experimentListStaleGoneMessage(name: string): string {
  return `別の操作で「${name}」の状態が先に変わっていました。一覧を読み込み直しましたが、この実験は見つかりませんでした`;
}

/** 一覧: 409 のあとの一覧の読み直しに失敗したときの文 (「再試行」を出す) */
export function experimentListStaleReloadFailedMessage(name: string): string {
  return `別の操作で「${name}」の状態が先に変わっていました。一覧を読み込み直せませんでした。「再試行」で読み込み直してから、もう一度操作してください`;
}

/**
 * 一覧のページ送り (#2107 Y9) のもとで、読み直した一覧 (表示しているページ) にその実験が無いときに続ける文。
 * 一覧はページで送るので、ページに無いことは実験が消えたことを意味しない (応答を待つ間にページを移した・
 * 新しい実験が増えて次のページへ押し出された)。画面はその実験を詳細の API で読み、今の状態を文に添える
 */
const LIST_OFF_PAGE_GUIDE = 'この実験は表示しているページにありません。詳細の画面で状態を確かめてから';

/** 一覧: 409 のあとに読み直した一覧 (表示しているページ) にその実験が無く、詳細の API で今の状態を読めたときの文 (#2107 Y9) */
export function experimentListStaleOffPageMessage(name: string, currentStatus: string): string {
  return `別の操作で「${name}」の状態が先に変わっていました（今の状態: ${experimentStatusLabel(currentStatus)}）。${LIST_OFF_PAGE_GUIDE}、もう一度操作してください`;
}

/**
 * 一覧: 409 のあとに読み直した一覧にその実験が無く、詳細の API で今の状態を読めなかったときの文 (「再試行」を出す。#2107 Y9)。
 * 一覧は読み直せているので「一覧を読み込み直せませんでした」とは言わない
 */
export function experimentListStaleStateReloadFailedMessage(name: string): string {
  return `別の操作で「${name}」の状態が先に変わっていました。今の状態を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください`;
}

/**
 * 状態の変更 (開始・完了・中止) の通信が reject された (応答を受け取れなかった) ときの文の操作の名前 (#2073)。
 * 応答が無いので変更が済んだかは分からない。済んでいた (自分の操作) ときにも合うよう「失敗した」「別の操作で」とは言わない
 */
const EXPERIMENT_STATUS_CHANGE_OPERATION_NAME = '状態の変更';

/** 詳細: 通信が reject され、実験を読み直せたときの文 (今の状態を表示名で添える。#2073) */
export function experimentNoResponseReloadedMessage(currentStatus: string): string {
  return `${statusChangeNoResponseSummary(EXPERIMENT_STATUS_CHANGE_OPERATION_NAME)}。今の状態（${experimentStatusLabel(currentStatus)}）を読み込み直したので、状態を確かめてから、必要ならもう一度操作してください`;
}

/** 詳細: 通信が reject され、読み直しにも失敗したときの文 (「再試行」を出す。#2073) */
export const EXPERIMENT_NO_RESPONSE_RELOAD_FAILED_MESSAGE = statusChangeNoResponseMessage(
  EXPERIMENT_STATUS_CHANGE_OPERATION_NAME,
  NO_RESPONSE_STATE_RELOAD_FAILED_GUIDE,
);

/** 一覧: 通信が reject され、一覧を読み直せたときの文 (#2073)。状態は一覧の行のバッジで見せる */
export function experimentListNoResponseReloadedMessage(name: string): string {
  return statusChangeNoResponseMessage(`「${name}」の${EXPERIMENT_STATUS_CHANGE_OPERATION_NAME}`, NO_RESPONSE_LIST_RELOADED_GUIDE);
}

/** 一覧: 通信が reject され、一覧の読み直しにも失敗したときの文 (「再試行」を出す。#2073) */
export function experimentListNoResponseReloadFailedMessage(name: string): string {
  return statusChangeNoResponseMessage(`「${name}」の${EXPERIMENT_STATUS_CHANGE_OPERATION_NAME}`, NO_RESPONSE_LIST_RELOAD_FAILED_GUIDE);
}

/**
 * 一覧: 通信が reject され、読み直した一覧 (表示しているページ) にその実験が無く、詳細の API で今の状態を読めたときの文 (#2107 Y9)。
 * 状態は一覧の行のバッジで見せられないので、今の状態を文に添える
 */
export function experimentListNoResponseOffPageMessage(name: string, currentStatus: string): string {
  return `${statusChangeNoResponseSummary(`「${name}」の${EXPERIMENT_STATUS_CHANGE_OPERATION_NAME}`)}。今の状態（${experimentStatusLabel(currentStatus)}）を読み込み直しました。${LIST_OFF_PAGE_GUIDE}、必要ならもう一度操作してください`;
}

/** 一覧: 通信が reject され、読み直した一覧にその実験が無く、詳細の API も 404 (実験が無い) だったときの文 (#2107 Y9) */
export function experimentListNoResponseGoneMessage(name: string): string {
  return `${statusChangeNoResponseSummary(`「${name}」の${EXPERIMENT_STATUS_CHANGE_OPERATION_NAME}`)}。一覧を読み込み直しましたが、この実験は見つかりませんでした`;
}

/**
 * 一覧: 通信が reject され、読み直した一覧にその実験が無く、詳細の API でも今の状態を読めなかったときの文 (「再試行」を出す。#2107 Y9)。
 * 一覧は読み直せているので「一覧を読み込めませんでした」とは言わない
 */
export function experimentListNoResponseStateReloadFailedMessage(name: string): string {
  return statusChangeNoResponseMessage(`「${name}」の${EXPERIMENT_STATUS_CHANGE_OPERATION_NAME}`, NO_RESPONSE_STATE_RELOAD_FAILED_GUIDE);
}
