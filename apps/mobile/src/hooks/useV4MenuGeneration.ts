import { useState, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { TargetSlot, MenuGenerationConstraints } from "../../../../types/domain";
import { getApi } from "../lib/api";
import { supabase } from "../lib/supabase";
import { handleStoredAiConsentFailure, isAiConsentRequiredError, promptAiConsentRequired } from "../lib/ai-consent";

// AsyncStorage key (localStorage 代替)
const STORAGE_KEY_V4_GENERATING = "v4MenuGenerating";

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

        // AsyncStorage に生成状態を保存 (localStorage 代替)
        await AsyncStorage.setItem(
          STORAGE_KEY_V4_GENERATING,
          JSON.stringify({
            requestId: data.requestId,
            timestamp: Date.now(),
            totalSlots: data.totalSlots,
          })
        );

        options.onGenerationStart?.(data.requestId);
        return data;
      } catch (err: any) {
        if (isAiConsentRequiredError(err)) {
          // リクエストは受け付けられていない。失敗の表示 (onError) は出さず、同意画面へ案内して、例外にせずに終える
          setIsGenerating(false);
          notifyAiConsentRequired();
          return null;
        }
        const errorMessage = err.message || "生成に失敗しました";
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
            const newData = payload.new as any;

            const progressWithStatus = {
              ...(newData.progress || {}),
              status: newData.status,
              errorMessage: newData.error_message,
            };
            onProgress(progressWithStatus);

            if (
              newData.status === "completed" ||
              newData.status === "failed"
            ) {
              setIsGenerating(false);
              await AsyncStorage.removeItem(STORAGE_KEY_V4_GENERATING);

              if (newData.status === "completed") {
                options.onGenerationComplete?.();
              } else if (handleStoredAiConsentFailure(newData.error_message, notifyAiConsentRequired)) {
                // 受け付けたあとに、サーバーが同意の判定で止めた: 同意画面へ案内したので、失敗の表示 (onError) は出さない
              } else {
                options.onError?.(
                  newData.error_message || "生成に失敗しました"
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
    await AsyncStorage.removeItem(STORAGE_KEY_V4_GENERATING);
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
      errorMessage: data.error_message,
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
