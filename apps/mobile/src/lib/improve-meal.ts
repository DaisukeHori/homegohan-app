/**
 * 「献立を改善」(ImproveMealModal) のリクエスト組み立て (#1138)
 *
 * 経緯:
 * モバイルの ImproveMealModal は、サーバーに存在しない API (POST /api/ai/menu/meal/improve) を
 * 呼んでいて、押すと必ず「改善に失敗しました」になっていた。
 * 専用 API は新設せず、Web の「献立を改善」(src/app/(main)/menus/weekly/page.tsx の handleImprove) と
 * 同じく、既存の POST /api/ai/menu/v4/generate を使う。
 *   - targetSlots          : 改善する日 × 選んだ食事タイプ
 *   - resolveExistingMeals : true (サーバーが既存の献立の plannedMealId を付けて「差し替え」にする)
 *   - note                 : AI栄養士の提案があれば要望として添える
 *   - constraints          : {}
 * 進捗カードと完了時の再読み込みは、weekly 画面の既存処理 (useV4MenuGeneration の onGenerationStart) が行う。
 *
 * React Native / Expo に依存しない純粋なロジックだけを置く (jest で素早く検証できるようにするため)。
 */

import { addDaysToDateString as addDaysToDateStringShared } from "@homegohan/shared";

import type { MenuGenerationConstraints, TargetSlot } from "../../../../types/domain";

/** 「献立を改善」で選べる食事タイプ (Web の改善モーダルと同じ 朝・昼・夕) */
export type ImproveMealType = "breakfast" | "lunch" | "dinner";

/** 表示・送信の順序 (選んだ順ではなく、常にこの順にする) */
export const IMPROVE_MEAL_TYPES: readonly ImproveMealType[] = ["breakfast", "lunch", "dinner"];

/** 改善モーダルで入力された内容 */
export interface ImproveMealRequest {
  /** 画面で選んでいた日 (YYYY-MM-DD)。栄養を分析した日でもある */
  date: string;
  /** 改善する食事タイプ */
  mealTypes: ImproveMealType[];
  /** true のとき、date の翌日を改善する */
  nextDay: boolean;
  /** 画面に表示中の AI栄養士の提案。あれば生成の要望 (note) として渡す */
  advice?: string | null;
}

/**
 * 要望 (note) の最大文字数。
 * Edge Function (supabase/functions/_shared/user-context.ts) が要望を 800 文字で切り詰めて使うため、それに合わせる。
 */
export const MAX_IMPROVE_NOTE_LENGTH = 800;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * YYYY-MM-DD の日付に days 日を足して YYYY-MM-DD で返す。
 *
 * 暦の計算は @homegohan/shared の addDaysToDateString (UTC の暦で計算するので、端末のタイムゾーン・夏時間に依存しない) に任せ、
 * ここでは入力の検証だけを行う。
 * (`new Date("YYYY-MM-DD")` を端末のローカル時刻の setDate で動かして toISOString すると、
 *  夏時間のある地域で日付が 1 日ずれることがある。)
 * shared 側は不正な値を黙って繰り上げる (2026-02-30 → 3/2) ので、サーバーへ送る前にここで弾く。
 * 形式が違う・実在しない日付 (2026-02-30 など) は例外にする。
 */
export function addDaysToDateString(dateStr: string, days: number): string {
  const match = DATE_PATTERN.exec(dateStr);
  if (!match) throw new Error(`invalid date: ${dateStr}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Date.UTC は 2026-02-30 を 3/2 に繰り上げるので、元の値に戻らない = 実在しない日付は弾く
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`invalid date: ${dateStr}`);
  }

  return addDaysToDateStringShared(dateStr, days);
}

/** 実際に改善する日 (nextDay なら選択日の翌日) */
export function resolveImproveTargetDate(request: Pick<ImproveMealRequest, "date" | "nextDay">): string {
  return request.nextDay ? addDaysToDateString(request.date, 1) : addDaysToDateString(request.date, 0);
}

/**
 * v4 生成 API に渡す targetSlots を作る。
 * 食事タイプは 朝→昼→夕 の順にし、重複や 朝・昼・夕 以外の値は取り除く
 * (サーバーは重複スロットを 400 にするため)。
 * plannedMealId はここでは付けない。resolveExistingMeals: true を指定してサーバーに解決させる。
 */
export function buildImproveTargetSlots(request: ImproveMealRequest): TargetSlot[] {
  const date = resolveImproveTargetDate(request);
  const selected = new Set<string>(request.mealTypes);
  return IMPROVE_MEAL_TYPES.filter((mealType) => selected.has(mealType)).map((mealType) => ({ date, mealType }));
}

/**
 * 生成の要望 (note) を作る。Web の handleImprove と同じ書き出しにする。
 * AI栄養士の提案が無ければ空文字 (= 要望なし)。
 * 「どの日の栄養分析か」は選択日 (request.date) で、翌日を改善するときも変わらない。
 */
export function buildImproveNote(request: ImproveMealRequest): string {
  const advice = request.advice?.trim();
  if (!advice) return "";
  const note = `${request.date}の栄養分析に基づくAI栄養士の提案を参考に改善してください：\n${advice}`;
  // 絵文字などのサロゲートペアを途中で切らないよう、コードポイント単位で切り詰める
  return Array.from(note).slice(0, MAX_IMPROVE_NOTE_LENGTH).join("");
}

/** 改善する日が today (YYYY-MM-DD) より前か。過去の献立は改善 (差し替え) の対象にしない */
export function isImproveTargetPast(
  request: Pick<ImproveMealRequest, "date" | "nextDay">,
  today: string,
): boolean {
  // YYYY-MM-DD 同士なので文字列比較で日付の前後を判定できる
  return resolveImproveTargetDate(request) < today;
}

/**
 * 利用者にそのまま見せてよい理由つきの失敗 (生成中・過去の日付など)。
 * 通信エラーなど想定外の失敗と区別して、改善モーダルがその文言を表示する。
 */
export class ImproveMealRejectedError extends Error {
  readonly isImproveMealRejected = true;

  constructor(message: string) {
    super(message);
    this.name = "ImproveMealRejectedError";
    // ES5 へのトランスパイルでも instanceof / プロトタイプが壊れないようにする
    Object.setPrototypeOf(this, ImproveMealRejectedError.prototype);
  }
}

export function isImproveMealRejectedError(error: unknown): error is ImproveMealRejectedError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { isImproveMealRejected?: unknown }).isImproveMealRejected === true
  );
}

/** useV4MenuGeneration().generate に渡す値 (改善では常にこの形) */
export interface ImproveGenerateParams {
  targetSlots: TargetSlot[];
  constraints: MenuGenerationConstraints;
  note: string;
  ultimateMode: false;
  resolveExistingMeals: true;
}

/** useV4MenuGeneration().generate と互換の関数 */
export type ImproveGenerate = (params: ImproveGenerateParams, options: { silent: true }) => Promise<unknown>;

/**
 * 「改善」の確定処理。入力を検証して、既存の v4 生成を「既存の献立を差し替える」指定で 1 回呼ぶ。
 *
 * - 過去の日付・食事タイプ未選択・別の生成が進行中のときは、生成を始めずに ImproveMealRejectedError を投げる。
 * - 生成リクエストの失敗はそのまま投げる。失敗は改善モーダルが表示するので、
 *   画面全体のエラー表示 (onError) には出さないよう silent を指定する。
 */
export async function submitImprove(params: {
  request: ImproveMealRequest;
  /**
   * 今日 (YYYY-MM-DD)。画面の「今日」と同じ Asia/Tokyo の日付 (@homegohan/shared の todayLocal()) を渡す。
   * 端末のタイムゾーンの今日 (new Date() の整形) を渡すと、過去の日付の判定が Web・サーバーとずれる (#1049 F7-21)。
   */
  today: string;
  /** 別の献立生成が進行中か */
  isBusy: boolean;
  generate: ImproveGenerate;
}): Promise<void> {
  const { request, today, isBusy, generate } = params;

  const targetSlots = buildImproveTargetSlots(request);
  if (targetSlots.length === 0) {
    throw new ImproveMealRejectedError("食事タイプを 1 つ以上選択してください");
  }

  if (isImproveTargetPast(request, today)) {
    throw new ImproveMealRejectedError(
      `${resolveImproveTargetDate(request)}は過去の日付のため改善できません。今日以降の日を選んでください。`,
    );
  }

  if (isBusy) {
    throw new ImproveMealRejectedError("別の献立を生成中です。完了してからもう一度お試しください。");
  }

  await generate(
    {
      targetSlots,
      constraints: {},
      note: buildImproveNote(request),
      ultimateMode: false,
      resolveExistingMeals: true,
    },
    // 失敗は改善モーダルが自分で表示する (画面全体のエラー表示に出さない)
    { silent: true },
  );
}
