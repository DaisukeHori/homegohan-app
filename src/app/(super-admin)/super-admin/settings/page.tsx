"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";

interface Setting {
  key: string;
  value: any;
  description: string | null;
  updatedAt: string;
}

export default function SuperAdminSettingsPage() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/super-admin/settings");
      if (res.ok) {
        const data = await res.json();
        setSettings(data.settings);
      }
    } catch (error) {
      console.error("Failed to fetch settings:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleSave = async (key: string) => {
    setSaving(true);
    try {
      let parsedValue;
      try {
        parsedValue = JSON.parse(editValue);
      } catch {
        parsedValue = editValue;
      }

      const res = await fetch("/api/super-admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: parsedValue }),
      });

      if (res.ok) {
        fetchSettings();
        setEditingKey(null);
      }
    } catch (error) {
      console.error("Failed to save setting:", error);
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (setting: Setting) => {
    setEditingKey(setting.key);
    setEditValue(typeof setting.value === 'object' ? JSON.stringify(setting.value, null, 2) : String(setting.value));
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
        <h1 className="text-2xl font-bold text-white">システム設定</h1>
        <p className="text-purple-300 mt-1">アプリケーション全体の設定を管理</p>
      </div>

      <div className="space-y-4">
        {settings.map((setting) => (
          <motion.div
            key={setting.key}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white/10 backdrop-blur rounded-2xl p-6"
          >
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-bold text-white">{setting.key}</h3>
                {setting.description && (
                  <p className="text-sm text-purple-300 mt-1">{setting.description}</p>
                )}
              </div>
              <button
                onClick={() => startEdit(setting)}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 transition-colors"
              >
                編集
              </button>
            </div>

            {editingKey === setting.key ? (
              <div className="space-y-3">
                <textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-purple-400"
                  rows={5}
                />
                <div className="flex gap-3">
                  <button
                    onClick={() => handleSave(setting.key)}
                    disabled={saving}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50 transition-colors"
                  >
                    {saving ? "保存中..." : "保存"}
                  </button>
                  <button
                    onClick={() => setEditingKey(null)}
                    className="px-4 py-2 bg-white/10 text-white rounded-lg text-sm hover:bg-white/20 transition-colors"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            ) : (
              <pre className="bg-white/5 rounded-xl p-4 text-sm text-purple-200 overflow-x-auto">
                {typeof setting.value === 'object' 
                  ? JSON.stringify(setting.value, null, 2)
                  : String(setting.value)
                }
              </pre>
            )}

            <p className="text-xs text-purple-400 mt-3">
              最終更新: {new Date(setting.updatedAt).toLocaleString('ja-JP')}
            </p>
          </motion.div>
        ))}
        {settings.length === 0 && (
          <div className="bg-white/10 backdrop-blur rounded-2xl p-8 text-center text-purple-300">
            設定がありません
          </div>
        )}
      </div>
    </div>
  );
}

