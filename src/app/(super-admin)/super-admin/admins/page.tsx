"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Admin {
  id: string;
  nickname: string;
  roles: string[];
  organizationId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  recentActionCount: number;
}

const ROLE_OPTIONS = [
  { value: "user", label: "User", color: "bg-gray-100 text-gray-700", description: "基本ユーザー" },
  { value: "support", label: "Support", color: "bg-teal-100 text-teal-700", description: "問い合わせ対応" },
  { value: "org_admin", label: "Org Admin", color: "bg-blue-100 text-blue-700", description: "組織管理" },
  { value: "admin", label: "Admin", color: "bg-orange-100 text-orange-700", description: "システム管理" },
  { value: "super_admin", label: "Super Admin", color: "bg-purple-100 text-purple-700", description: "最高権限" },
];

export default function SuperAdminAdminsPage() {
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingAdmin, setEditingAdmin] = useState<Admin | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

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

  const handleEditClick = (admin: Admin) => {
    setEditingAdmin(admin);
    setSelectedRoles(admin.roles || ['user']);
  };

  const handleRoleToggle = (role: string) => {
    if (role === 'user') return; // userは常に必要
    if (role === 'super_admin') return; // super_adminはこのUIで変更不可
    
    setSelectedRoles(prev => 
      prev.includes(role) 
        ? prev.filter(r => r !== role)
        : [...prev, role]
    );
  };

  const handleSave = async () => {
    if (!editingAdmin) return;
    
    setSaving(true);
    try {
      const res = await fetch(`/api/super-admin/admins/${editingAdmin.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles: selectedRoles }),
      });

      if (res.ok) {
        fetchAdmins();
        setEditingAdmin(null);
      } else {
        const data = await res.json();
        alert(data.error || "ロール変更に失敗しました");
      }
    } catch (error) {
      console.error("Failed to change roles:", error);
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
        <h1 className="text-2xl font-bold text-white">管理者管理</h1>
        <p className="text-purple-300 mt-1">管理者ロールの割り当てと確認（複数ロール対応）</p>
      </div>

      <div className="bg-white/10 backdrop-blur rounded-2xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-white/5">
            <tr>
              <th className="text-left px-6 py-4 text-sm font-medium text-purple-200">ユーザー</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-purple-200">現在のロール</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-purple-200">最終ログイン</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-purple-200">今週のアクション</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-purple-200">操作</th>
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
                  <div className="flex flex-wrap gap-1">
                    {(admin.roles || []).map((role) => (
                      <span
                        key={role}
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          ROLE_OPTIONS.find(r => r.value === role)?.color || 'bg-gray-100'
                        }`}
                      >
                        {ROLE_OPTIONS.find(r => r.value === role)?.label || role}
                      </span>
                    ))}
                  </div>
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
                  {!admin.roles?.includes('super_admin') ? (
                    <button
                      onClick={() => handleEditClick(admin)}
                      className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 transition-colors"
                    >
                      編集
                    </button>
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

      {/* Edit Modal */}
      <AnimatePresence>
        {editingAdmin && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
            onClick={() => setEditingAdmin(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl p-6 w-full max-w-md shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-xl font-bold text-white mb-2">ロール編集</h2>
              <p className="text-purple-300 text-sm mb-6">{editingAdmin.nickname}</p>

              <div className="space-y-3 mb-6">
                {ROLE_OPTIONS.map((option) => {
                  const isSelected = selectedRoles.includes(option.value);
                  const isDisabled = option.value === 'user' || option.value === 'super_admin';
                  
                  return (
                    <button
                      key={option.value}
                      onClick={() => handleRoleToggle(option.value)}
                      disabled={isDisabled}
                      className={`w-full flex items-center justify-between p-4 rounded-xl transition-all ${
                        isSelected
                          ? 'bg-purple-600/30 border-2 border-purple-500'
                          : 'bg-white/5 border-2 border-transparent hover:border-white/20'
                      } ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-5 h-5 rounded-md flex items-center justify-center ${
                          isSelected ? 'bg-purple-500' : 'bg-white/20'
                        }`}>
                          {isSelected && <span className="text-white text-xs">✓</span>}
                        </div>
                        <div className="text-left">
                          <p className="font-medium text-white">{option.label}</p>
                          <p className="text-xs text-purple-300">{option.description}</p>
                        </div>
                      </div>
                      <span className={`px-2 py-1 rounded-full text-xs ${option.color}`}>
                        {option.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 py-3 bg-purple-600 text-white rounded-xl font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? "保存中..." : "保存"}
                </button>
                <button
                  onClick={() => setEditingAdmin(null)}
                  className="flex-1 py-3 bg-white/10 text-white rounded-xl font-medium hover:bg-white/20 transition-colors"
                >
                  キャンセル
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
