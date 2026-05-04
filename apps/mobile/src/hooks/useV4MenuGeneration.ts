import { useState, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { TargetSlot, MenuGenerationConstraints } from "../../../../types/domain";
import { getApi } from "../lib/api";
import { supabase } from "../lib/supabase";

// AsyncStorage key (localStorage 代替)
const STORAGE_KEY_V4_GENERATING = "v4MenuGenerating";

interface UseV4MenuGenerationOptions {
  onGenerationStart?: (requestId: string) => void;
  onGenerationComplete?: () => void;
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

  const generate = useCallback(
    async (params: GenerateParams) => {
      setIsGenerating(true);
      setError(null);

      try {
        const api = getApi();
        const data = await api.post<{
          requestId: string;
          totalSlots: number;
        }>("/api/ai/menu/v4/generate", {
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
        const errorMessage = err.message || "生成に失敗しました";
        setError(errorMessage);
        options.onError?.(errorMessage);
        throw err;
      }
      // Note: isGenerating stays true until progress tracking shows completion
    },
    [options]
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
    [options]
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
