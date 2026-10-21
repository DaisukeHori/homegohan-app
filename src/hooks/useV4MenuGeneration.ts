"use client";

import { useState, useCallback } from "react";
import type { TargetSlot, MenuGenerationConstraints } from "@/types/domain";
import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@homegohan/shared";
import { AiConsentRequiredError, aiFetch, isAiConsentRequiredResponse } from "@/lib/ai/consent-required";
import { weeklyMenuRequestErrorMessageForDisplay } from "@/lib/weekly-menu-request-error";
import { requestProgressForDisplay } from "@/lib/request-progress-display";

interface UseV4MenuGenerationOptions {
  onGenerationStart?: (requestId: string) => void;
  onGenerationComplete?: () => void;
  /**
   * 失敗の通知。受け付けたあとの失敗 (subscribeToProgress) では、リクエストの行に保存された文 (error_message) を渡す。
   * その文が「同意が無くてサーバーが止めた」もの (T15 / #1154) のときもここに届くので、呼び出し側は
   * handleStoredAiConsentFailure(error) で見分け、true なら自分のエラー表示を出さない (同意画面が案内する)。
   * 受け付ける前に止められたとき (403 AI_CONSENT_REQUIRED) は呼ばない (generate が AiConsentRequiredError を投げる)。
   */
  onError?: (error: string) => void;
}

interface GenerateParams {
  targetSlots: TargetSlot[];
  constraints: MenuGenerationConstraints;
  note: string;
  ultimateMode?: boolean;
  resolveExistingMeals?: boolean;
}

export function useV4MenuGeneration(options: UseV4MenuGenerationOptions = {}) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async (params: GenerateParams) => {
    setIsGenerating(true);
    setError(null);

    try {
      const response = await aiFetch("/api/ai/menu/v4/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetSlots: params.targetSlots,
          resolveExistingMeals: params.resolveExistingMeals ?? false,
          constraints: params.constraints,
          note: params.note,
          ultimateMode: params.ultimateMode ?? false,
        }),
      });

      // 同意が必要で止められた (T15 / #1154): 同意画面 (AiConsentRequiredHost) が案内するので、onError (失敗の表示) は呼ばない
      if (await isAiConsentRequiredResponse(response)) {
        throw new AiConsentRequiredError();
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "生成リクエストに失敗しました");
      }

      const data = await response.json();
      setRequestId(data.requestId);
      
      // Store generation state in localStorage for persistence
      // ultimateMode: 究極モードで始めた生成か (#1597)。週間献立の画面が再読み込みで進捗を戻すとき、進捗の段 (究極 / 通常) をこれで決める
      // (行の progress.totalSteps は、行を作った時点では枠の数で、究極モードかを表さない)
      localStorage.setItem("v4MenuGenerating", JSON.stringify({
        requestId: data.requestId,
        timestamp: Date.now(),
        totalSlots: data.totalSlots,
        ultimateMode: params.ultimateMode === true,
      }));

      options.onGenerationStart?.(data.requestId);

      return data;
    } catch (err: any) {
      if (err instanceof AiConsentRequiredError) {
        setIsGenerating(false);
        throw err;
      }
      const errorMessage = err.message || "生成に失敗しました";
      setError(errorMessage);
      options.onError?.(errorMessage);
      throw err;
    } finally {
      // Note: isGenerating stays true until progress tracking shows completion
    }
  }, [options]);

  const subscribeToProgress = useCallback((reqId: string, onProgress: (progress: any) => void) => {
    const supabase = createClient();
    
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
        (payload) => {
          const newData = payload.new as Tables<"weekly_menu_requests">;

          // progressにstatusも含めて渡す（コールバック側で完了判定できるように）
          // DB の既定値の progress (ワーカーがまだ進捗を書いていない行) の文は画面に出さず、置き換える (#1911)
          const progressObj = requestProgressForDisplay(
            (typeof newData.progress === 'object' && newData.progress !== null && !Array.isArray(newData.progress))
              ? (newData.progress as Record<string, unknown>)
              : {},
          );
          // 行の error_message は、こちらで書いた定型の文 (同意・上限・失敗の固定の文など) だけをそのまま出し、
          // それ以外 (#1478 より前に Edge Function が書いた例外の文面など) は汎用の文に寄せる
          const displayErrorMessage = weeklyMenuRequestErrorMessageForDisplay(newData.error_message);
          const progressWithStatus = {
            ...progressObj,
            status: newData.status,
            errorMessage: displayErrorMessage,
          };
          onProgress(progressWithStatus);
          
          if (newData.status === "completed" || newData.status === "failed") {
            setIsGenerating(false);
            localStorage.removeItem("v4MenuGenerating");
            
            if (newData.status === "completed") {
              options.onGenerationComplete?.();
            } else {
              options.onError?.(displayErrorMessage || "生成に失敗しました");
            }
            
            channel.unsubscribe();
          }
        }
      )
      .subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, [options]);

  const cancelGeneration = useCallback(() => {
    setIsGenerating(false);
    setRequestId(null);
    localStorage.removeItem("v4MenuGenerating");
  }, []);

  // リクエストの現在の状態をDBから取得
  const getRequestStatus = useCallback(async (reqId: string) => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("weekly_menu_requests")
      .select("status, progress, error_message")
      .eq("id", reqId)
      .single();

    if (error) {
      console.error("[getRequestStatus] Failed to fetch:", error);
      return null;
    }

    return {
      status: data.status,
      progress: data.progress,
      // 画面がそのまま出すので、こちらで書いた定型の文以外は汎用の文に寄せる (#1478)
      errorMessage: weeklyMenuRequestErrorMessageForDisplay(data.error_message),
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
