"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { createClient } from "@/lib/supabase/client";
import { ArrowLeft, Camera, Plus, Trash2, RefreshCw, Package, AlertCircle, X, Pencil } from "lucide-react";
import { PantryItemForm, emptyPantryItemFormValues, type PantryItemFormValues } from "@/components/pantry/PantryItemForm";

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
  // UX2-18: 手入力での追加・編集（写真のみ・編集不可だった機能非対称を解消）
  const [formValues, setFormValues] = useState<PantryItemFormValues>(emptyPantryItemFormValues);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [showManualForm, setShowManualForm] = useState(false);
  const [savingManual, setSavingManual] = useState(false);

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

  // UX2-18: 手入力での新規追加を開く（写真のみだった機能非対称の解消）
  const openManualAdd = () => {
    setEditingItemId(null);
    setFormValues(emptyPantryItemFormValues);
    setShowManualForm(true);
  };

  // UX2-18: 一覧タップで編集フォームを開く（編集不可だった機能非対称の解消）
  const openEditItem = (item: PantryItem) => {
    setEditingItemId(item.id);
    setFormValues({
      name: item.name,
      amount: item.amount || "",
      expirationDate: item.expirationDate || "",
    });
    setShowManualForm(true);
  };

  const closeManualForm = () => {
    setShowManualForm(false);
    setEditingItemId(null);
    setFormValues(emptyPantryItemFormValues);
  };

  // UX2-18: 手入力フォームの送信（新規追加 or 編集更新）。週間献立側の FridgeModal と同じ API を使う
  const handleManualSubmit = async () => {
    if (!formValues.name) return;
    setSavingManual(true);
    try {
      if (editingItemId) {
        const res = await fetch(`/api/pantry/${editingItemId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formValues.name,
            amount: formValues.amount,
            expirationDate: formValues.expirationDate || null,
          }),
        });
        if (!res.ok) throw new Error("更新に失敗しました");
        const { item } = await res.json();
        setItems((prev) => prev.map((it) => (it.id === editingItemId ? { ...it, ...item } : it)));
      } else {
        const res = await fetch("/api/pantry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formValues.name,
            amount: formValues.amount,
            category: "other",
            expirationDate: formValues.expirationDate || null,
          }),
        });
        if (!res.ok) throw new Error("追加に失敗しました");
        const { item } = await res.json();
        setItems((prev) => [...prev, item]);
      }
      closeManualForm();
    } catch (err: any) {
      setError(err.message || "保存に失敗しました");
    } finally {
      setSavingManual(false);
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
        <div className="flex items-center gap-2">
          {/* UX2-18: 週間献立側の FridgeModal と機能を揃え、手入力での追加もできるようにする */}
          <button
            onClick={openManualAdd}
            data-testid="add-manually-btn"
            className="flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-medium"
            style={{ backgroundColor: colors.card, color: colors.accent, border: `1px solid ${colors.accent}` }}
          >
            <Plus size={16} />
            手入力
          </button>
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
            <div className="flex items-center gap-2">
              <button
                onClick={openManualAdd}
                className="flex items-center gap-2 px-5 py-3 rounded-full text-sm font-medium"
                style={{ backgroundColor: colors.card, color: colors.accent, border: `1px solid ${colors.accent}` }}
              >
                <Plus size={16} />
                手入力で追加
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium"
                style={{ backgroundColor: colors.accent, color: "white" }}
              >
                <Camera size={16} />
                冷蔵庫を撮影して追加
              </button>
            </div>
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
                role="button"
                tabIndex={0}
                onClick={() => openEditItem(item)}
                onKeyDown={(e) => { if (e.key === 'Enter') openEditItem(item); }}
                className="flex items-center justify-between p-4 rounded-2xl cursor-pointer"
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
                {/* UX2-18: 編集不可だった機能非対称を解消 */}
                <button
                  onClick={(e) => { e.stopPropagation(); openEditItem(item); }}
                  aria-label="編集"
                  className="ml-2 p-2 rounded-full"
                  style={{ color: colors.textMuted }}
                >
                  <Pencil size={16} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(item.id); }}
                  aria-label="削除"
                  className="ml-1 p-2 rounded-full"
                  style={{ color: colors.textMuted }}
                >
                  <Trash2 size={16} />
                </button>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* UX2-18: 手入力での追加・編集モーダル（写真専用だった /pantry ページに機能を追加） */}
      <AnimatePresence>
        {showManualForm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end lg:items-center justify-center bg-black/40"
            onClick={closeManualForm}
          >
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="w-full lg:max-w-sm rounded-t-3xl lg:rounded-3xl p-5"
              style={{ backgroundColor: colors.card }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <p className="font-bold" style={{ color: colors.text }}>
                  {editingItemId ? "食材を編集" : "食材を追加"}
                </p>
                <button onClick={closeManualForm} className="p-1 rounded-full" style={{ color: colors.textMuted }}>
                  <X size={18} />
                </button>
              </div>
              <PantryItemForm
                values={formValues}
                onChange={setFormValues}
                onSubmit={handleManualSubmit}
                isEditing={Boolean(editingItemId)}
                submitting={savingManual}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
