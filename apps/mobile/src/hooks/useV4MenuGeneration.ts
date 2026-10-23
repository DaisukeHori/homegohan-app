import { useState, useCallback } from "react";

import type { TargetSlot, MenuGenerationConstraints } from "../../../../types/domain";
import { getApi } from "../lib/api";
import { getJapaneseApiErrorMessage } from "../lib/api-error";
import { supabase } from "../lib/supabase";
import { handleStoredAiConsentFailure, isAiConsentRequiredError, promptAiConsentRequired } from "../lib/ai-consent";
import { menuRequestErrorMessageForDisplay } from "../lib/menu-request-error";

// 生成中の状態は端末に保存しない (#1049 F7-20)。以前は AsyncStorage の "v4MenuGenerating" に書いていたが、
// 読む処理がどこにも無く (Web の localStorage と違い、画面を開き直したときの復元に使われていなかった)、
// 形式も persistence.ts の TTL 付きの形と違っていた。旧ビルドが書いた値は、ログアウトで消す (src/lib/user-storage.ts)。

/**
 * Realtime の UPDATE で届く weekly_menu_requests の行のうち、subscribeToProgress が読む列。
 * error_message は画面に出す前に menuRequestErrorMessageForDisplay で確かめるので unknown で受ける
 * (文字列でない値や、こちらで書いた文でない値は汎用の文に寄せる #1478)。
 */
type WeeklyMenuRequestRealtimeRow = {
  status?: string | null;
  progress?: Record<string, unknown> | null;
  error_message?: unknown;
};

interface UseV4MenuGenerationOptions {
  onGenerationStart?: (requestId: string) => void;
  onGenerationComplete?: () => void;
  onError?: (error: string) => void;
  /**
   * 同意が必要で止められたとき (T15 / #1154) に呼ぶ。onError は呼ばない。
   *   - 受け付ける前に止められた (generate が 403 AI_CONSENT_REQUIRED を受けた)
   *   - 受け付けたあとに止められた (subscribeToProgress が、サーバーが書いた「同意が必要です」の文で失敗を受けた)
   * 省略すると、同意画面への案内 (promptAiConsentRequired) を出す。モーダルから生成する画面は、
   * モーダルを閉じてから案内を出すように渡す (閉じないと、案内から開いた同意画面がモーダルの下に隠れる)。
   */
  onAiConsentRequired?: () => void;
}

interface GenerateParams {
  targetSlots: TargetSlot[];
  constraints: MenuGenerationConstraints;
  note: string;
  ultimateMode?: boolean;
  resolveExistingMeals?: boolean;
}

interface GenerateCallOptions {
  /**
   * true のとき、失敗を options.onError に通知せず、例外としてだけ呼び出し元へ返す。
   * 呼び出し元が自分でエラーを表示する場合 (例: 献立改善モーダルを開いたまま再試行させる) に使う。
   * 既定 (false) は従来どおり onError にも通知する。
   * 同意が必要で止められたときは、silent でも例外にしない (generate の戻り値の説明を参照)。
   */
  silent?: boolean;
}

/** 生成を受け付けたときの応答 */
interface GenerateAccepted {
  requestId: string;
  totalSlots: number;
}

export function useV4MenuGeneration(options: UseV4MenuGenerationOptions = {}) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 同意が必要で止められたことを知らせる (onAiConsentRequired。省略時は同意画面への案内) */
  const notifyAiConsentRequired = useCallback(() => {
    if (options.onAiConsentRequired) options.onAiConsentRequired();
    else promptAiConsentRequired();
  }, [options]);

  /**
   * 生成を始める。受け付けられたら応答を返す。
   * 同意が必要で止められたら (403 AI_CONSENT_REQUIRED。T15 / #1154)、onAiConsentRequired (省略時は同意画面への案内) を呼んで
   * null を返す。例外にはしない: 案内はもう出ているので、呼び出し側の catch が「失敗しました」を重ねて出さないようにするため
   * (silent で呼ぶ改善モーダルも同じ。呼び出し側は null を「生成は始まっていない・案内は出し済み」として扱う)。
   * それ以外の失敗は例外を投げる (silent でなければ onError にも通知する)。
   */
  const generate = useCallback(
    async (params: GenerateParams, callOptions: GenerateCallOptions = {}): Promise<GenerateAccepted | null> => {
      setIsGenerating(true);
      setError(null);

      try {
        const api = getApi();
        const data = await api.post<GenerateAccepted>("/api/ai/menu/v4/generate", {
          targetSlots: params.targetSlots,
          resolveExistingMeals: params.resolveExistingMeals ?? false,
          constraints: params.constraints,
          note: params.note,
          ultimateMode: params.ultimateMode ?? false,
        });

        setRequestId(data.requestId);

        options.onGenerationStart?.(data.requestId);
        return data;
      } catch (err: any) {
        if (isAiConsentRequiredError(err)) {
          // リクエストは受け付けられていない。失敗の表示 (onError) は出さず、同意画面へ案内して、例外にせずに終える
          setIsGenerating(false);
          notifyAiConsentRequired();
          return null;
        }
        // 本文の文だけを渡す (`HTTP 500 …: {"error":…,"code":"INTERNAL_ERROR"}` の生の文字列を画面に出さない。#1917)
        const errorMessage = getJapaneseApiErrorMessage(err, "生成に失敗しました");
        setError(errorMessage);
        // リクエストが受け付けられなかったので、進行中の生成は無い (生成中のまま残さない)
        setIsGenerating(false);
        if (!callOptions.silent) {
          options.onError?.(errorMessage);
        }
        throw err;
      }
      // Note: isGenerating stays true until progress tracking shows completion
    },
    [options, notifyAiConsentRequired]
  );

  const subscribeToProgress = useCallback(
    (reqId: string, onProgress: (progress: any) => void) => {
      const channel = supabase
        .channel(`v4-menu-progress-${reqId}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "weekly_menu_requests",
            filter: `id=eq.${reqId}`,
          },
          async (payload) => {
            const newData = payload.new as WeeklyMenuRequestRealtimeRow;

            // 行の error_message は、こちらで書いた定型の文 (同意・上限・失敗の固定の文など) だけをそのまま出し、
            // それ以外 (#1478 より前に Edge Function が書いた例外の文面など) は汎用の文に寄せる
            const displayErrorMessage = menuRequestErrorMessageForDisplay(newData.error_message);
            const progressWithStatus = {
              ...(newData.progress || {}),
              status: newData.status,
              errorMessage: displayErrorMessage,
            };
            onProgress(progressWithStatus);

            if (
              newData.status === "completed" ||
              newData.status === "failed"
            ) {
              setIsGenerating(false);

              if (newData.status === "completed") {
                options.onGenerationComplete?.();
              } else if (!handleStoredAiConsentFailure(newData.error_message, notifyAiConsentRequired)) {
                // 受け付けたあとにサーバーが同意の判定で止めたもの (同意画面へ案内した) は、失敗として知らせない
                options.onError?.(
                  displayErrorMessage || "生成に失敗しました"
                );
              }

              channel.unsubscribe();
            }
          }
        )
        .subscribe();

      return () => {
        channel.unsubscribe();
      };
    },
    [options, notifyAiConsentRequired]
  );

  const cancelGeneration = useCallback(async () => {
    setIsGenerating(false);
    setRequestId(null);
  }, []);

  const getRequestStatus = useCallback(async (reqId: string) => {
    const { data, error: fetchError } = await supabase
      .from("weekly_menu_requests")
      .select("status, progress, error_message")
      .eq("id", reqId)
      .single();

    if (fetchError) {
      console.error("[getRequestStatus] Failed to fetch:", fetchError);
      return null;
    }

    return {
      status: data.status,
      progress: data.progress,
      // 画面がそのまま出すので、こちらで書いた定型の文以外は汎用の文に寄せる (#1478)
      errorMessage: menuRequestErrorMessageForDisplay(data.error_message),
    };
  }, []);

  return {
    isGenerating,
    requestId,
    error,
    generate,
    subscribeToProgress,
    cancelGeneration,
    getRequestStatus,
  };
}
