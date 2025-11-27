"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";

interface Admin {
  id: string;
  nickname: string;
  role: string;
  organizationId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  recentActionCount: number;
}

const ROLE_OPTIONS = [
  { value: "user", label: "User", color: "bg-gray-100 text-gray-700" },
  { value: "support", label: "Support", color: "bg-teal-100 text-teal-700" },
  { value: "org_admin", label: "Org Admin", color: "bg-blue-100 text-blue-700" },
  { value: "admin", label: "Admin", color: "bg-orange-100 text-orange-700" },
  { value: "super_admin", label: "Super Admin", color: "bg-purple-100 text-purple-700" },
];

export default function SuperAdminAdminsPage() {
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [loading, setLoading] = useState(true);
  const [changingRole, setChangingRole] = useState<string | null>(null);

  const fetchAdmins = useCallback(async () => {
    try {
      const res = await fetch("/api/super-admin/admins");
      if (res.ok) {
        const data = await res.json();
        setAdmins(data.admins);
      }
    } catch (error) {
      console.error("Failed to fetch admins:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAdmins();
  }, [fetchAdmins]);

  const handleRoleChange = async (userId: string, newRole: string) => {
    if (!confirm(`このユーザーのロールを ${ROLE_OPTIONS.find(r => r.value === newRole)?.label} に変更しますか？`)) {
      return;
    }

    setChangingRole(userId);
    try {
      const res = await fetch(`/api/super-admin/admins/${userId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });

      if (res.ok) {
        fetchAdmins();
      } else {
        const data = await res.json();
        alert(data.error || "ロール変更に失敗しました");
      }
    } catch (error) {
      console.error("Failed to change role:", error);
    } finally {
      setChangingRole(null);
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
        <h1 className="text-2xl font-bold text-white">管理者管理</h1>
        <p className="text-purple-300 mt-1">管理者ロールの割り当てと確認</p>
      </div>

      <div className="bg-white/10 backdrop-blur rounded-2xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-white/5">
            <tr>
              <th className="text-left px-6 py-4 text-sm font-medium text-purple-200">ユーザー</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-purple-200">現在のロール</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-purple-200">最終ログイン</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-purple-200">今週のアクション</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-purple-200">ロール変更</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {admins.map((admin) => (
              <motion.tr
                key={admin.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="hover:bg-white/5"
              >
                <td className="px-6 py-4">
                  <p className="font-medium text-white">{admin.nickname}</p>
                  <p className="text-xs text-purple-300">{admin.id.substring(0, 8)}...</p>
                </td>
                <td className="px-6 py-4">
                  <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                    ROLE_OPTIONS.find(r => r.value === admin.role)?.color
                  }`}>
                    {ROLE_OPTIONS.find(r => r.value === admin.role)?.label}
                  </span>
                </td>
                <td className="px-6 py-4 text-sm text-purple-200">
                  {admin.lastLoginAt 
                    ? new Date(admin.lastLoginAt).toLocaleDateString('ja-JP')
                    : "-"
                  }
                </td>
                <td className="px-6 py-4 text-sm text-purple-200">
                  {admin.recentActionCount}件
                </td>
                <td className="px-6 py-4">
                  {admin.role !== 'super_admin' ? (
                    <select
                      value={admin.role}
                      onChange={(e) => handleRoleChange(admin.id, e.target.value)}
                      disabled={changingRole === admin.id}
                      className="px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-400 disabled:opacity-50"
                    >
                      {ROLE_OPTIONS.filter(r => r.value !== 'super_admin').map((role) => (
                        <option key={role.value} value={role.value} className="text-gray-800">
                          {role.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-purple-400 text-sm">変更不可</span>
                  )}
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
        {admins.length === 0 && (
          <div className="p-8 text-center text-purple-300">管理者がいません</div>
        )}
      </div>
    </div>
  );
}

