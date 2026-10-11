/**
 * 外国の AI 事業者への提供の同意: サーバーに「同意が必要です」で止められたときに、同意画面へ案内する (T15 / #1154)
 *
 * AI へ送る API は、未同意の利用者のデータを送らずに 403 { error, code: "AI_CONSENT_REQUIRED" } を返す
 * (Web の src/lib/ai/consent-guard.ts。判定の本体は supabase/functions/_shared/ai-consent.ts)。
 * アプリの各 AI 機能の画面は、API の失敗を受けたら、自分のエラー表示の前に handleAiConsentRequiredError(e) を呼ぶ。
 * true が返ったら「同意が必要です」の案内を出したので、自分のエラー表示は出さずに終える。
 *
 *   } catch (e) {
 *     if (handleAiConsentRequiredError(e)) return;
 *     Alert.alert("エラー", getApiErrorMessage(e, "..."));
 *   }
 *
 * 非同期の処理 (献立の生成・買い物リストの作り直し) は、受け付けたあとに同意の判定で止まると、リクエストの行に人向けの文を書いて
 * 失敗にする。失敗を表示する場所は、その文を handleStoredAiConsentFailure に渡し、true なら自分のエラー表示を出さずに終える。
 *
 * 案内の「同意画面を開く」は、アプリの同意画面 (/settings/ai-consent。Web の同じページを WebView で開く) へ移る。
 * 同意画面は画面の遷移 (router.push) で開くので、RN の Modal が開いたままだと、同意画面はそのモーダルの下に隠れる。
 * 案内を出す側は、「同意画面を開く」を押した時点でモーダルが 1 枚も開いていないようにする:
 *   - 案内を出す前に閉じる (閉じても失うものが無いモーダル)。または
 *   - promptAiConsentRequired({ beforeOpenConsentScreen }) で、「同意画面を開く」を押したときに閉じる
 *     (案内の前に閉じると編集中の内容を捨ててしまうモーダル。「閉じる」を押したときは閉じない)
 * モーダルの上に開く子のモーダル (1日献立の作成・写真の解析・献立の改善) は自分で案内を出さない。自分を閉じてから、
 * 開いた側から受け取った onAiConsentRequired を呼ぶ。開いた側が自分 (と、その下のモーダル) を上の規則で閉じて案内を出す
 * (子が自分だけを閉じて案内を出すと、下に開いたままの親のモーダルが同意画面を隠す)。
 * 画面そのものがモーダルのこともある: ルートの Stack で presentation: "modal" として開く画面 (apps/mobile/app/_layout.tsx の
 * meals/new)。iOS のネイティブのスタックは、modal の画面のあとに push した画面を modal の下 (push の積み重ね) に入れるので、
 * その画面から同意画面へ移ると、同意画面が modal の画面の下に隠れる。modal で開く画面は、案内に
 * { beforeOpenConsentScreen: useLeaveModalRouteBeforeConsentScreen() の戻り値 } を渡し、「同意画面を開く」を押したときに
 * 自分を閉じてから移る (handleAiConsentRequiredError(e, options) / promptAiConsentRequired(options))。
 * modal で開く画面の一覧と、そこで出す案内がこの形であることは tests/ai-consent-mobile-modal-nesting.test.ts が検査する。
 * 画面を開くと自動で AI に送る処理 (栄養士のコメントなど) は handleAiConsentRequiredError を使わず、
 * isAiConsentRequiredError で見分けて、案内の一文 (AI_CONSENT_AUTOMATIC_LOCKED_NOTE) だけを出す (勝手に案内を出さない)。
 */
import { useCallback } from "react";
import { Alert } from "react-native";
import { router, useNavigation } from "expo-router";

import {
  AI_CONSENT_AUTOMATIC_LOCKED_NOTE,
  AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE,
  AI_CONSENT_REQUIRED_MESSAGE,
  AI_CONSENT_REQUIRED_STATUS,
  AI_CONSENT_SETTINGS_ENTRY_TITLE,
  AI_CONSENT_SKIPPED_NOTE,
  AI_DAILY_LIMIT_AUTOMATIC_NOTE,
  AI_DAILY_LIMIT_SKIPPED_NOTE,
  aiConsentReasonOfStoredError,
  aiSkippedReasonOf,
  aiSummarySkippedNote,
  isAiConsentRequiredBody,
  type AiSkippedReason,
} from "../../../../supabase/functions/_shared/ai-consent";

/**
 * 文面は Web と共用の定義をそのまま使う (2 か所に持たない)。
 *   - AI_CONSENT_AUTOMATIC_LOCKED_NOTE: 画面を開くと自動で作る AI のコメントを、同意が無くて作らなかったときに出す一文
 *   - AI_CONSENT_SKIPPED_NOTE / AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE: 保存と AI の分析を一緒にする画面で、AI の分析を省いたときの一文
 *   - AI_CONSENT_SETTINGS_ENTRY_TITLE: 設定タブの項目の名前 (案内の一文が「設定の「…」から」と指す先)
 *   - aiSkippedReasonOf: 応答の aiSkipped を、出し分けの理由 (consent_required / check_failed) に直す
 *   - aiSummarySkippedNote: AI 相談を閉じた応答の aiSkipped から、要約を省いた旨の一文を選ぶ
 */
export {
  AI_CONSENT_AUTOMATIC_LOCKED_NOTE,
  AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE,
  AI_DAILY_LIMIT_AUTOMATIC_NOTE,
  AI_DAILY_LIMIT_SKIPPED_NOTE,
  AI_CONSENT_SETTINGS_ENTRY_TITLE,
  AI_CONSENT_SKIPPED_NOTE,
  aiSkippedReasonOf,
  aiSummarySkippedNote,
  type AiSkippedReason,
};

/** アプリの同意画面 (Web の /settings/ai-consent を WebView で開く画面) */
export const AI_CONSENT_SCREEN_PATH = "/settings/ai-consent";

/** 案内を出してから、次の案内を出さない時間 (ミリ秒)。1 つの操作で複数の API が同時に止められても、案内を重ねない */
const PROMPT_DEDUP_MS = 3_000;

// "HTTP 403 Forbidden: {...}" / HTTP/2 で statusText が空の "HTTP 403 : {...}" (api-error.ts と同じ形)
const HTTP_ERROR_PATTERN = /^HTTP (\d{3})[^:]*:\s*([\s\S]+)$/;

let lastPromptAt = Number.NEGATIVE_INFINITY;

/** テスト用: 案内の重複防止の記録を消す */
export function resetAiConsentPromptForTests(): void {
  lastPromptAt = Number.NEGATIVE_INFINITY;
}

/** API の失敗 (getApi() が投げた Error) が「同意が必要です」(403 + AI_CONSENT_REQUIRED) か */
export function isAiConsentRequiredError(error: unknown): boolean {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== "string") return false;
  const match = HTTP_ERROR_PATTERN.exec(message);
  if (!match || Number(match[1]) !== AI_CONSENT_REQUIRED_STATUS) return false;
  try {
    return isAiConsentRequiredBody(JSON.parse(match[2]));
  } catch {
    return false;
  }
}

/** fetch を直接使う画面 (ストリーミングなど) のための判定。本文は clone して読むので、呼び出し側はあとで本文を読める */
export async function isAiConsentRequiredResponse(res: Response): Promise<boolean> {
  if (res.status !== AI_CONSENT_REQUIRED_STATUS) return false;
  try {
    return isAiConsentRequiredBody(await res.clone().json());
  } catch {
    return false;
  }
}

/** 「同意が必要です」の案内の出し方 */
export interface PromptAiConsentOptions {
  /**
   * 「同意画面を開く」を押したときに、同意画面へ移る前に呼ぶ。案内の下に開いたままのモーダルを、ここで閉じる
   * (閉じないと、同意画面がモーダルの下に隠れる)。「閉じる」を押したときは呼ばない (編集中の内容を捨てない)
   */
  beforeOpenConsentScreen?: () => void;
}

/** 「同意が必要です」の案内を出す (同意画面へ移るボタン付き)。短い間に何度呼ばれても 1 回だけ出す */
export function promptAiConsentRequired(options: PromptAiConsentOptions = {}): void {
  const now = Date.now();
  if (now - lastPromptAt < PROMPT_DEDUP_MS) return;
  lastPromptAt = now;
  const { beforeOpenConsentScreen } = options;
  Alert.alert("同意が必要です", AI_CONSENT_REQUIRED_MESSAGE, [
    { text: "閉じる", style: "cancel" },
    {
      text: "同意画面を開く",
      onPress: () => {
        beforeOpenConsentScreen?.();
        router.push(AI_CONSENT_SCREEN_PATH);
      },
    },
  ]);
}

/**
 * API の失敗が「同意が必要です」なら案内を出して true を返す。呼び出し側は true なら自分のエラー表示を省く。
 * options は案内の出し方 (promptAiConsentRequired と同じ)。modal で開く画面は beforeOpenConsentScreen を渡す (先頭の説明)
 */
export function handleAiConsentRequiredError(error: unknown, options: PromptAiConsentOptions = {}): boolean {
  if (!isAiConsentRequiredError(error)) return false;
  promptAiConsentRequired(options);
  return true;
}

/**
 * ルートの Stack で presentation: "modal" として開く画面 (meals/new) が、案内の beforeOpenConsentScreen に渡す関数を返す。
 * 「同意画面を開く」を押したときに、その画面を閉じる (閉じてから同意画面へ移るので、同意画面が modal の画面の下に隠れない)。
 * 閉じるのは、その画面がいまの一番上 (フォーカスがある) で、戻る先があるときだけ:
 *   - 一番上でない: 案内が出る前に利用者が画面を閉じた (解析を待つ間に下へスワイプした) など。このとき router.back() は
 *     別の画面を閉じてしまう
 *   - 戻る先が無い: その画面がスタックの先頭 (リンクから直接開いた)。先頭の画面は modal の指定でも push として積まれるので、
 *     同意画面はその上に出る (閉じなくてよい)
 */
export function useLeaveModalRouteBeforeConsentScreen(): () => void {
  const navigation = useNavigation();
  return useCallback(() => {
    if (navigation.isFocused() && router.canGoBack()) router.back();
  }, [navigation]);
}

/**
 * 非同期の処理が失敗で終わったときに、リクエストの行に保存された文 (weekly_menu_requests.error_message /
 * shopping_list_requests.result.error) を渡す。サーバーが同意の判定で止めたもの (未同意。aiConsentDeniedStoredMessage が書いた文)
 * なら「同意が必要です」の案内を出して true を返す。呼び出し側は true なら自分のエラー表示を出さない。
 * 同意の状況を読めなくて止めたもの (一時的に使えません) は false (保存された文は人向けなので、そのまま出してよい)。
 * prompt には、モーダルを開いている画面が「モーダルを閉じてから案内を出す」関数を渡せる (省略時は案内を出すだけ)。
 */
export function handleStoredAiConsentFailure(stored: unknown, prompt: () => void = promptAiConsentRequired): boolean {
  if (aiConsentReasonOfStoredError(stored) !== "consent_required") return false;
  prompt();
  return true;
}
