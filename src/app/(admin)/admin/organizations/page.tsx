"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Organization {
  id: string;
  name: string;
  plan: string;
  industry: string | null;
  subscriptionStatus: string;
  memberCount: number;
  createdAt: string;
}

export default function AdminOrganizationsPage() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ name: "", plan: "standard", industry: "", contactEmail: "" });
  const [submitting, setSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const fetchOrgs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchQuery) params.set("q", searchQuery);

      const res = await fetch(`/api/admin/organizations?${params}`);
      if (res.ok) {
        const data = await res.json();
        setOrganizations(data.organizations);
      }
    } catch (error) {
      console.error("Failed to fetch organizations:", error);
    } finally {
      setLoading(false);
    }
  }, [searchQuery]);

  useEffect(() => {
    fetchOrgs();
  }, [fetchOrgs]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const res = await fetch("/api/admin/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (res.ok) {
        fetchOrgs();
        setShowForm(false);
        setFormData({ name: "", plan: "standard", industry: "", contactEmail: "" });
      }
    } catch (error) {
      console.error("Failed to create organization:", error);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-orange-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-bold text-gray-800">組織管理</h1>
        <div className="flex gap-3">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="組織名で検索..."
            className="px-4 py-2 border border-gray-200 rounded-lg"
          />
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2 bg-orange-500 text-white rounded-lg font-medium hover:bg-orange-600"
          >
            + 新規作成
          </button>
        </div>
      </div>

      <AnimatePresence>
        {showForm && (
          <motion.form
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            onSubmit={handleCreate}
            className="bg-white rounded-xl p-6 space-y-4"
          >
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">組織名</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">プラン</label>
                <select
                  value={formData.plan}
                  onChange={(e) => setFormData({ ...formData, plan: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="standard">Standard</option>
                  <option value="premium">Premium</option>
                  <option value="enterprise">Enterprise</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">業界</label>
                <input
                  type="text"
                  value={formData.industry}
                  onChange={(e) => setFormData({ ...formData, industry: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">連絡先メール</label>
                <input
                  type="email"
                  value={formData.contactEmail}
                  onChange={(e) => setFormData({ ...formData, contactEmail: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button type="submit" disabled={submitting} className="px-4 py-2 bg-orange-500 text-white rounded-lg disabled:opacity-50">
                {submitting ? "作成中..." : "作成"}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 bg-gray-100 rounded-lg">
                キャンセル
              </button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      <div className="bg-white rounded-xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">組織名</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">プラン</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">業界</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">ステータス</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">メンバー</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">作成日</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {organizations.map((org) => (
              <tr key={org.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-800">{org.name}</td>
                <td className="px-4 py-3 text-sm text-gray-600 capitalize">{org.plan}</td>
                <td className="px-4 py-3 text-sm text-gray-600">{org.industry || "-"}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                    org.subscriptionStatus === 'active' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                  }`}>
                    {org.subscriptionStatus}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">{org.memberCount}名</td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {new Date(org.createdAt).toLocaleDateString('ja-JP')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {organizations.length === 0 && (
          <div className="p-8 text-center text-gray-400">組織がありません</div>
        )}
      </div>
    </div>
  );
}

