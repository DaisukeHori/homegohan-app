"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";

interface Invite {
  id: string;
  email: string;
  role: string;
  departmentName: string | null;
  token: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  isExpired: boolean;
  isAccepted: boolean;
}

export default function OrgInvitesPage() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState("member");
  const [submitting, setSubmitting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchInvites = useCallback(async () => {
    try {
      const res = await fetch("/api/org/invites");
      if (res.ok) {
        const data = await res.json();
        setInvites(data.invites);
      }
    } catch (error) {
      console.error("Failed to fetch invites:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInvites();
  }, [fetchInvites]);

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/org/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail, role: newRole }),
      });

      if (res.ok) {
        setNewEmail("");
        setShowForm(false);
        fetchInvites();
      } else {
        const data = await res.json();
        alert(data.error || "招待の作成に失敗しました");
      }
    } catch (error) {
      console.error("Failed to create invite:", error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteInvite = async (inviteId: string) => {
    if (!confirm("この招待を取り消しますか？")) return;

    try {
      const res = await fetch(`/api/org/invites?id=${inviteId}`, {
        method: "DELETE",
      });

      if (res.ok) {
        fetchInvites();
      }
    } catch (error) {
      console.error("Failed to delete invite:", error);
    }
  };

  const copyInviteLink = (token: string, id: string) => {
    const link = `${window.location.origin}/invite/${token}`;
    navigator.clipboard.writeText(link);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
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
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">メンバー招待</h1>
          <p className="text-gray-500 mt-1">メールで招待リンクを共有してください</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
        >
          + 新規招待
        </button>
      </div>

      {showForm && (
        <motion.form
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          onSubmit={handleCreateInvite}
          className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              メールアドレス
            </label>
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              required
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="user@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              役割
            </label>
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="member">メンバー</option>
              <option value="manager">マネージャー</option>
            </select>
          </div>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? "作成中..." : "招待を作成"}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-6 py-3 bg-gray-100 text-gray-700 rounded-xl font-medium hover:bg-gray-200 transition-colors"
            >
              キャンセル
            </button>
          </div>
        </motion.form>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="divide-y divide-gray-50">
          {invites.map((invite) => (
            <div key={invite.id} className="p-4 flex items-center justify-between">
              <div>
                <p className="font-medium text-gray-800">{invite.email}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-sm text-gray-500">{invite.role}</span>
                  {invite.isAccepted ? (
                    <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full">承認済</span>
                  ) : invite.isExpired ? (
                    <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full">期限切れ</span>
                  ) : (
                    <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs rounded-full">保留中</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!invite.isAccepted && !invite.isExpired && (
                  <button
                    onClick={() => copyInviteLink(invite.token, invite.id)}
                    className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 transition-colors"
                  >
                    {copiedId === invite.id ? "コピー済 ✓" : "リンクをコピー"}
                  </button>
                )}
                {!invite.isAccepted && (
                  <button
                    onClick={() => handleDeleteInvite(invite.id)}
                    className="px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm hover:bg-red-100 transition-colors"
                  >
                    取消
                  </button>
                )}
              </div>
            </div>
          ))}
          {invites.length === 0 && (
            <div className="p-8 text-center text-gray-400">
              招待はありません
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

