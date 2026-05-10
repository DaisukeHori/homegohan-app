"use client";

// src/app/(org)/org/invites/page.tsx
// (設計書 03-ui-spec.md §1.1)
// 招待発行フォーム + 招待履歴一覧 (revoke ボタン付き)

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";

interface Invite {
  id: string;
  email: string;
  role: string;
  token: string;
  status: string;
  expires_at: string;
  invite_url?: string;
}

export default function OrgInvitesPage() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "member">("member");
  const [customMessage, setCustomMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchInvites = useCallback(async () => {
    try {
      const res = await fetch("/api/org/invites");
      if (res.ok) {
        const data = await res.json();
        // 新 API レスポンス (invites 配列) を処理
        const items = data.invites ?? [];
        setInvites(
          items.map((i: Record<string, unknown>) => ({
            id: i.id as string,
            email: (i.email as string) ?? "",
            role: (i.role as string) ?? (i.invited_role as string) ?? "member",
            token: (i.token as string) ?? "",
            status: getStatus(i),
            expires_at: (i.expires_at ?? i.expiresAt) as string,
          })),
        );
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
    setSubmitError(null);
    try {
      const res = await fetch("/api/org/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: newEmail,
          role: newRole,
          custom_message: customMessage || undefined,
        }),
      });

      if (res.ok) {
        setNewEmail("");
        setCustomMessage("");
        setNewRole("member");
        setShowForm(false);
        fetchInvites();
      } else {
        const data = await res.json();
        setSubmitError(data.error?.message ?? data.error ?? "招待の作成に失敗しました");
      }
    } catch (error) {
      console.error("Failed to create invite:", error);
      setSubmitError("通信エラーが発生しました");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    if (!confirm("この招待を取り消しますか？")) return;

    try {
      const res = await fetch(`/api/org/invites/${inviteId}/revoke`, {
        method: "POST",
      });

      if (res.ok) {
        fetchInvites();
      } else {
        const data = await res.json();
        alert(data.error?.message ?? "招待の取り消しに失敗しました");
      }
    } catch (error) {
      console.error("Failed to revoke invite:", error);
    }
  };

  const copyInviteLink = (token: string, id: string) => {
    const link = `${window.location.origin}/invite/${token}`;
    navigator.clipboard.writeText(link);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case "pending":   return { label: "保留中",    className: "bg-yellow-100 text-yellow-700" };
      case "accepted":  return { label: "承諾済",    className: "bg-green-100 text-green-700" };
      case "rejected":  return { label: "拒否済",    className: "bg-gray-100 text-gray-600" };
      case "expired":   return { label: "期限切れ",  className: "bg-red-100 text-red-700" };
      case "revoked":   return { label: "取消済",    className: "bg-orange-100 text-orange-700" };
      default:          return { label: status,       className: "bg-gray-100 text-gray-600" };
    }
  };

  const roleLabel = (role: string) => {
    switch (role) {
      case "owner":  return "オーナー";
      case "admin":  return "管理者";
      case "member": return "メンバー";
      default:       return role;
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
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">組織招待管理</h1>
          <p className="text-gray-500 mt-1">メールで招待リンクを共有してください</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
        >
          + 新しいメンバーを招待
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
              onChange={(e) => setNewRole(e.target.value as "admin" | "member")}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="member">メンバー</option>
              <option value="admin">管理者</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              メッセージ (任意)
            </label>
            <input
              type="text"
              value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)}
              maxLength={500}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="招待メッセージ (省略可)"
            />
          </div>

          {submitError && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-600">
              {submitError}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? "送信中..." : "招待を送信"}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); setSubmitError(null); }}
              className="px-6 py-3 bg-gray-100 text-gray-700 rounded-xl font-medium hover:bg-gray-200 transition-colors"
            >
              キャンセル
            </button>
          </div>
        </motion.form>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-50">
          <h2 className="font-semibold text-gray-700">招待履歴</h2>
        </div>
        <div className="divide-y divide-gray-50">
          {invites.map((invite) => {
            const { label, className: sc } = statusLabel(invite.status);
            return (
              <div key={invite.id} className="p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium text-gray-800 truncate">{invite.email}</p>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className="text-sm text-gray-500">{roleLabel(invite.role)}</span>
                    <span className={`px-2 py-0.5 text-xs rounded-full ${sc}`}>{label}</span>
                    {invite.expires_at && (
                      <span className="text-xs text-gray-400">
                        期限 {new Date(invite.expires_at).toLocaleDateString("ja-JP")}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {invite.status === "pending" && invite.token && (
                    <button
                      onClick={() => copyInviteLink(invite.token, invite.id)}
                      className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 transition-colors"
                    >
                      {copiedId === invite.id ? "コピー済 ✓" : "リンクをコピー"}
                    </button>
                  )}
                  {invite.status === "pending" && (
                    <button
                      onClick={() => handleRevokeInvite(invite.id)}
                      className="px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm hover:bg-red-100 transition-colors"
                    >
                      取消
                    </button>
                  )}
                </div>
              </div>
            );
          })}
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

// 旧 GET レスポンスと新 POST レスポンスを両方サポートするステータス解決
function getStatus(i: Record<string, unknown>): string {
  if (i.status) return i.status as string;
  if (i.isAccepted) return "accepted";
  if (i.isExpired) return "expired";
  return "pending";
}
