"use client";

import { useState, useCallback } from "react";
import type { TargetSlot, MenuGenerationConstraints } from "@/types/domain";
import { createClient } from "@/lib/supabase/client";

interface UseV4MenuGenerationOptions {
  onGenerationStart?: (requestId: string) => void;
  onGenerationComplete?: () => void;
  onError?: (error: string) => void;
}

interface GenerateParams {
  targetSlots: TargetSlot[];
  constraints: MenuGenerationConstraints;
  note: string;
}

export function useV4MenuGeneration(options: UseV4MenuGenerationOptions = {}) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async (params: GenerateParams) => {
    setIsGenerating(true);
    setError(null);

    try {
      const response = await fetch("/api/ai/menu/v4/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetSlots: params.targetSlots,
          constraints: params.constraints,
          note: params.note,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "生成リクエストに失敗しました");
      }

      const data = await response.json();
      setRequestId(data.requestId);
      
      // Store generation state in localStorage for persistence
      localStorage.setItem("v4MenuGenerating", JSON.stringify({
        requestId: data.requestId,
        timestamp: Date.now(),
        totalSlots: data.totalSlots,
      }));

      options.onGenerationStart?.(data.requestId);

      return data;
    } catch (err: any) {
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
          const newData = payload.new as any;
          
          if (newData.progress) {
            onProgress(newData.progress);
          }
          
          if (newData.status === "completed" || newData.status === "failed") {
            setIsGenerating(false);
            localStorage.removeItem("v4MenuGenerating");
            
            if (newData.status === "completed") {
              options.onGenerationComplete?.();
            } else {
              options.onError?.(newData.error_message || "生成に失敗しました");
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

  return {
    isGenerating,
    requestId,
    error,
    generate,
    subscribeToProgress,
    cancelGeneration,
  };
}
