"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";

const FLAG_LABELS: Record<string, { label: string; description: string }> = {
  ai_chat_enabled: { label: "AIチャット", description: "AIアドバイザー機能の有効/無効" },
  meal_photo_analysis: { label: "食事写真分析", description: "写真からの栄養推定機能" },
  recipe_generation: { label: "レシピ生成", description: "AIによるレシピ提案機能" },
  weekly_menu_generation: { label: "週間献立生成", description: "1週間分の献立自動生成" },
  health_insights: { label: "健康インサイト", description: "AI健康分析・アドバイス" },
  comparison_feature: { label: "比較機能", description: "セグメント別の比較・ランキング" },
  organization_features: { label: "法人機能", description: "法人向け機能全般" },
  maintenance_mode: { label: "メンテナンスモード", description: "サービス全体をメンテナンス中に" },
};

export default function SuperAdminFeatureFlagsPage() {
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchFlags = useCallback(async () => {
    try {
      const res = await fetch("/api/super-admin/feature-flags");
      if (res.ok) {
        const data = await res.json();
        setFlags(data.flags);
      }
    } catch (error) {
      console.error("Failed to fetch flags:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFlags();
  }, [fetchFlags]);

  const handleToggle = async (key: string) => {
    const newFlags = { ...flags, [key]: !flags[key] };
    setSaving(true);

    try {
      const res = await fetch("/api/super-admin/feature-flags", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flags: newFlags }),
      });

      if (res.ok) {
        setFlags(newFlags);
      }
    } catch (error) {
      console.error("Failed to update flags:", error);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-purple-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">機能フラグ</h1>
        <p className="text-purple-300 mt-1">機能のON/OFFをリアルタイムで制御</p>
      </div>

      <div className="bg-white/10 backdrop-blur rounded-2xl overflow-hidden">
        <div className="divide-y divide-white/10">
          {Object.entries(flags).map(([key, enabled]) => {
            const info = FLAG_LABELS[key] || { label: key, description: "" };
            const isMaintenance = key === "maintenance_mode";

            return (
              <motion.div
                key={key}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className={`p-6 flex items-center justify-between ${isMaintenance && enabled ? "bg-red-900/30" : ""}`}
              >
                <div>
                  <h3 className="font-bold text-white flex items-center gap-2">
                    {info.label}
                    {isMaintenance && enabled && (
                      <span className="px-2 py-0.5 bg-red-500 text-white text-xs rounded-full animate-pulse">
                        有効中
                      </span>
                    )}
                  </h3>
                  <p className="text-sm text-purple-300 mt-1">{info.description}</p>
                </div>
                <button
                  onClick={() => handleToggle(key)}
                  disabled={saving}
                  className={`relative w-14 h-8 rounded-full transition-colors ${
                    enabled 
                      ? isMaintenance ? "bg-red-500" : "bg-green-500" 
                      : "bg-white/20"
                  } disabled:opacity-50`}
                >
                  <motion.div
                    animate={{ x: enabled ? 24 : 4 }}
                    className="absolute top-1 w-6 h-6 bg-white rounded-full shadow-lg"
                  />
                </button>
              </motion.div>
            );
          })}
        </div>
      </div>

      <div className="bg-yellow-900/30 border border-yellow-500/30 rounded-2xl p-6">
        <h3 className="font-bold text-yellow-400 flex items-center gap-2">
          ⚠️ 注意
        </h3>
        <p className="text-yellow-200 text-sm mt-2">
          機能フラグの変更は即座に全ユーザーに反映されます。
          メンテナンスモードを有効にすると、一般ユーザーはサービスを利用できなくなります。
        </p>
      </div>
    </div>
  );
}

