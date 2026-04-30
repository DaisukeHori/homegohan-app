"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { createClient } from "@/lib/supabase/client";
import { ArrowLeft, Camera, Plus, Trash2, RefreshCw, Package, AlertCircle } from "lucide-react";

const colors = {
  bg: "#FAF9F7",
  card: "#FFFFFF",
  text: "#1A1A1A",
  textLight: "#4A4A4A",
  textMuted: "#9A9A9A",
  accent: "#E07A5F",
  accentLight: "#FDF0ED",
  border: "#EEEEEE",
  success: "#4CAF50",
  successLight: "#E8F5E9",
  error: "#F44336",
};

interface PantryItem {
  id: string;
  name: string;
  amount: string | null;
  category: string;
  expirationDate: string | null;
  addedAt: string;
}

interface AnalysisResult {
  detailedIngredients: {
    name: string;
    quantity?: string;
    category?: string;
    freshness?: string;
    daysRemaining?: number;
  }[];
  summary: string;
  suggestions: string[];
}

export default function PantryPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<PantryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch("/api/pantry");
      if (res.ok) {
        const data = await res.json();
        setItems(data.items || []);
      }
    } catch (err) {
      console.error("Failed to fetch pantry items:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // プレビュー表示
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    setAnalysisResult(null);
    setError(null);
    setAnalyzing(true);

    try {
      // Base64に変換してAPIへ送信
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((acc, byte) => acc + String.fromCharCode(byte), "")
      );

      const res = await fetch("/api/ai/analyze-fridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: base64,
          mimeType: file.type || "image/jpeg",
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "解析に失敗しました");
      }

      const data = await res.json();
      setAnalysisResult({
        detailedIngredients: data.detailedIngredients || [],
        summary: data.summary || "",
        suggestions: data.suggestions || [],
      });
    } catch (err: any) {
      setError(err.message || "解析中にエラーが発生しました");
    } finally {
      setAnalyzing(false);
      // reset file input
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSaveIngredients = async (mode: "append" | "replace") => {
    if (!analysisResult) return;
    setSaving(true);
    setError(null);

    try {
      const ingredients = analysisResult.detailedIngredients.map((item) => ({
        name: item.name,
        amount: item.quantity || null,
        category: item.category || undefined,
        daysRemaining: item.daysRemaining,
        freshness: item.freshness,
      }));

      const res = await fetch("/api/pantry/from-photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ingredients, mode }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "保存に失敗しました");
      }

      setAnalysisResult(null);
      setPreviewUrl(null);
      await fetchItems();
    } catch (err: any) {
      setError(err.message || "保存中にエラーが発生しました");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/pantry/${id}`, { method: "DELETE" });
      if (res.ok) {
        setItems((prev) => prev.filter((item) => item.id !== id));
      }
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  const categoryLabel: Record<string, string> = {
    vegetable: "野菜",
    meat: "肉類",
    fish: "魚介",
    dairy: "乳製品・卵",
    other: "その他",
  };

  const isExpiringSoon = (dateStr: string | null): boolean => {
    if (!dateStr) return false;
    const diff = (new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= 3;
  };

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4 flex items-center justify-between" style={{ backgroundColor: colors.bg }}>
        <div className="flex items-center gap-2">
          <button onClick={() => router.back()} className="p-2 -ml-2">
            <ArrowLeft size={24} style={{ color: colors.text }} />
          </button>
          <h1 className="font-bold" style={{ color: colors.text }}>食材管理</h1>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          data-testid="add-by-photo-btn"
          className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium"
          style={{ backgroundColor: colors.accent, color: "white" }}
        >
          <Camera size={16} />
          写真で追加
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handlePhotoSelect}
      />

      {/* エラー表示 */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="mx-4 mb-4 p-3 rounded-xl flex items-center gap-2"
            style={{ backgroundColor: "#FFEBEE" }}
          >
            <AlertCircle size={18} style={{ color: colors.error }} />
            <p className="text-sm" style={{ color: colors.error }}>{error}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 解析中 */}
      {analyzing && (
        <div className="mx-4 mb-4 p-4 rounded-2xl" style={{ backgroundColor: colors.card }}>
          {previewUrl && (
            <img src={previewUrl} alt="解析中の写真" className="w-full h-48 object-cover rounded-xl mb-3" />
          )}
          <div className="flex items-center gap-3">
            <RefreshCw size={20} className="animate-spin" style={{ color: colors.accent }} />
            <p className="text-sm font-medium" style={{ color: colors.textLight }}>
              冷蔵庫の食材を解析中…
            </p>
          </div>
        </div>
      )}

      {/* 解析結果 */}
      <AnimatePresence>
        {analysisResult && !analyzing && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="mx-4 mb-4 p-4 rounded-2xl"
            style={{ backgroundColor: colors.card }}
          >
            {previewUrl && (
              <img src={previewUrl} alt="解析した写真" className="w-full h-48 object-cover rounded-xl mb-3" />
            )}
            <p className="text-sm font-medium mb-2" style={{ color: colors.text }}>
              解析結果: {analysisResult.detailedIngredients.length}品目を検出
            </p>
            {analysisResult.summary && (
              <p className="text-sm mb-3" style={{ color: colors.textLight }}>{analysisResult.summary}</p>
            )}

            {/* 検出された食材リスト */}
            <div className="space-y-1 mb-3 max-h-40 overflow-y-auto">
              {analysisResult.detailedIngredients.map((item, i) => (
                <div key={i} className="flex items-center justify-between py-1">
                  <span className="text-sm" style={{ color: colors.text }}>{item.name}</span>
                  {item.quantity && (
                    <span className="text-xs" style={{ color: colors.textMuted }}>{item.quantity}</span>
                  )}
                </div>
              ))}
            </div>

            {/* 提案料理 */}
            {analysisResult.suggestions.length > 0 && (
              <div className="mb-3 p-3 rounded-xl" style={{ backgroundColor: colors.accentLight }}>
                <p className="text-xs font-medium mb-1" style={{ color: colors.accent }}>おすすめレシピ</p>
                {analysisResult.suggestions.map((s, i) => (
                  <p key={i} className="text-sm" style={{ color: colors.textLight }}>・{s}</p>
                ))}
              </div>
            )}

            {/* 保存ボタン */}
            <div className="flex gap-2">
              <button
                onClick={() => handleSaveIngredients("append")}
                disabled={saving}
                className="flex-1 py-2 rounded-xl text-sm font-medium"
                style={{ backgroundColor: colors.accent, color: "white" }}
              >
                {saving ? "保存中…" : "追加保存"}
              </button>
              <button
                onClick={() => handleSaveIngredients("replace")}
                disabled={saving}
                className="flex-1 py-2 rounded-xl text-sm font-medium"
                style={{ backgroundColor: colors.card, color: colors.accent, border: `1px solid ${colors.accent}` }}
              >
                全て置き換え
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 食材一覧 */}
      <div className="px-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw size={24} className="animate-spin" style={{ color: colors.accent }} />
          </div>
        ) : items.length === 0 ? (
          <div
            data-testid="pantry-empty-state"
            className="flex flex-col items-center justify-center py-16 gap-4"
          >
            <Package size={48} style={{ color: colors.textMuted }} />
            <p className="text-sm" style={{ color: colors.textMuted }}>食材がありません</p>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium"
              style={{ backgroundColor: colors.accent, color: "white" }}
            >
              <Camera size={16} />
              冷蔵庫を撮影して追加
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex items-center justify-between p-4 rounded-2xl"
                style={{ backgroundColor: colors.card }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium truncate" style={{ color: colors.text }}>{item.name}</p>
                    {item.expirationDate && isExpiringSoon(item.expirationDate) && (
                      <span
                        data-testid="expiry-soon-badge"
                        className="text-xs px-2 py-0.5 rounded-full"
                        style={{ backgroundColor: "#FFEBEE", color: colors.error }}
                      >
                        期限間近
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs" style={{ color: colors.textMuted }}>
                      {categoryLabel[item.category] || item.category}
                    </span>
                    {item.amount && (
                      <span className="text-xs" style={{ color: colors.textMuted }}>・{item.amount}</span>
                    )}
                    {item.expirationDate && (
                      <span
                        className="text-xs"
                        style={{ color: isExpiringSoon(item.expirationDate) ? colors.error : colors.textMuted }}
                      >
                        ・{item.expirationDate}まで
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(item.id)}
                  className="ml-3 p-2 rounded-full"
                  style={{ color: colors.textMuted }}
                >
                  <Trash2 size={16} />
                </button>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
