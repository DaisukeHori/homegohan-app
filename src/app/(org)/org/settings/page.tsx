"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";

interface Organization {
  id: string;
  name: string;
  plan: string;
  industry: string | null;
  employeeCount: number | null;
  subscriptionStatus: string;
  subscriptionExpiresAt: string | null;
  contactEmail: string | null;
  contactName: string | null;
}

export default function OrgSettingsPage() {
  const [org, setOrg] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    industry: "",
    employeeCount: "",
    contactEmail: "",
    contactName: "",
  });

  useEffect(() => {
    const fetchOrg = async () => {
      try {
        const res = await fetch("/api/org/settings");
        if (res.ok) {
          const data = await res.json();
          setOrg(data.organization);
          setFormData({
            name: data.organization.name || "",
            industry: data.organization.industry || "",
            employeeCount: data.organization.employeeCount?.toString() || "",
            contactEmail: data.organization.contactEmail || "",
            contactName: data.organization.contactName || "",
          });
        }
      } catch (error) {
        console.error("Failed to fetch org:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchOrg();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const res = await fetch("/api/org/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          industry: formData.industry || null,
          employeeCount: formData.employeeCount ? parseInt(formData.employeeCount) : null,
          contactEmail: formData.contactEmail || null,
          contactName: formData.contactName || null,
        }),
      });

      if (res.ok) {
        alert("設定を保存しました");
      }
    } catch (error) {
      console.error("Failed to save settings:", error);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">組織設定</h1>
        <p className="text-gray-500 mt-1">組織の基本情報を編集</p>
      </div>

      {org && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100"
          >
            <p className="text-sm text-gray-500">プラン</p>
            <p className="text-xl font-bold text-gray-800 capitalize">{org.plan}</p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100"
          >
            <p className="text-sm text-gray-500">ステータス</p>
            <p className="text-xl font-bold text-gray-800 capitalize">{org.subscriptionStatus}</p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100"
          >
            <p className="text-sm text-gray-500">有効期限</p>
            <p className="text-xl font-bold text-gray-800">
              {org.subscriptionExpiresAt 
                ? new Date(org.subscriptionExpiresAt).toLocaleDateString('ja-JP')
                : "-"
              }
            </p>
          </motion.div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              組織名
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              業界
            </label>
            <input
              type="text"
              value={formData.industry}
              onChange={(e) => setFormData({ ...formData, industry: e.target.value })}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例: IT"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              従業員数
            </label>
            <input
              type="number"
              value={formData.employeeCount}
              onChange={(e) => setFormData({ ...formData, employeeCount: e.target.value })}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              担当者名
            </label>
            <input
              type="text"
              value={formData.contactName}
              onChange={(e) => setFormData({ ...formData, contactName: e.target.value })}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              連絡先メール
            </label>
            <input
              type="email"
              value={formData.contactEmail}
              onChange={(e) => setFormData({ ...formData, contactEmail: e.target.value })}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "保存中..." : "設定を保存"}
        </button>
      </form>
    </div>
  );
}

