"use client";

// src/app/(org)/org/invites/page.tsx
// (設計書 03-ui-spec.md §1.1)
// 招待発行フォーム + 招待履歴一覧 (revoke ボタン付き)

import { useEffect, useState, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { ORG_UNKNOWN_VALUE_LABEL } from "@/lib/org-plans";
import { operationFailureMessage, operationNetworkFailureMessage } from "@/lib/admin/api-error-message";
import { ORG_WRITE_OPERATION, orgWriteNoResponseMessage } from "@/lib/org-write-no-response";

interface Invite {
  id: string;
  email: string;
  role: string;
  token: string;
  status: string;
  expires_at: string;
  invite_url?: string;
}

/** 招待の取消が失敗した (応答が届いたうえで断られた) ときの文。通信が切れたときは使わない (#2080 U4) */
const REVOKE_FAILURE_MESSAGE = "招待の取り消しに失敗しました";
/** 招待の履歴を読み込めなかったときの文の頭 (後ろに理由を添える)。空の履歴 (「招待はありません」) と見分けるために出す (#2050) */
const LOAD_FAILURE_SUMMARY = "招待の履歴を読み込めませんでした";

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
  // 履歴を読み込めなかったときの文。あるあいだは履歴と「招待はありません」の代わりにこの文と「再試行」を出す (#2050)
  const [loadError, setLoadError] = useState<string | null>(null);
  // 取消の応答を待っている招待の id。待つあいだは取消のボタンを止める
  // (二度押しで 2 本目を送ると、取り消せているのに INVITE_NOT_FOUND で「招待の取り消しに失敗しました」が出るため。#2050)
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // 招待の送信か取消のどちらかの書き込みとそのあとの読み直しの応答を待っているか (10/26 の整合ゲート 1026e。#2050)。
  // 書き込みのあとの読み直しは履歴を丸ごと差し替えるので、2 つの書き込みを重ねると、先に送った読み直しの応答が後に届いたとき、
  // その古い履歴 (例: 取り消した招待がまだ「招待中」の履歴) で表示が上書きされ、取り消した招待の取消をもう一度押せてしまう
  // (#2053 のクーポン・機能パッケージと同じ型)。待つあいだは送信と取消のボタン (と履歴の「再試行」。#2059) を止め、押されても送らない。
  // ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り
  const writeInFlightRef = useRef(false);
  const isWriting = submitting || revokingId !== null;

  // 履歴を読めたら true (書き込みの通信が切れたあとの文で、読み直せたかどうかの案内を出し分けるために返す。#2080 U4)
  const fetchInvites = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/org/invites");
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        setLoadError(operationFailureMessage(LOAD_FAILURE_SUMMARY, res.status, body));
        return false;
      }
      const data = await res.json();
      // GET /api/org/invites の応答 (src/schemas/membership/organization-invite.ts の OrgInviteListResponseSchema)。
      // role は招待で付ける役割 (invited_role)、status は表示用の状態 (取り消し・拒否・期限切れを含む)
      const items = data.invites ?? [];
      setInvites(
        items.map((i: Record<string, unknown>) => ({
          id: i.id as string,
          email: (i.email as string) ?? "",
          role: (i.role as string) ?? "",
          token: (i.token as string) ?? "",
          status: getStatus(i),
          expires_at: (i.expires_at ?? i.expiresAt) as string,
        })),
      );
      setLoadError(null);
      return true;
    } catch (error) {
      console.error("Failed to fetch invites:", error);
      setLoadError(operationNetworkFailureMessage(LOAD_FAILURE_SUMMARY));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInvites();
  }, [fetchInvites]);

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    // 取消 (とその読み直し) の応答を待つあいだは送らない (writeInFlightRef)
    if (!newEmail || writeInFlightRef.current) return;

    writeInFlightRef.current = true;
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
        // 読み直しの応答まで待ってからボタンを戻す (待たずに次の書き込みを送ると、この読み直しの古い履歴で上書きされうるため)
        await fetchInvites();
      } else {
        const data = await res.json();
        setSubmitError(data.error?.message ?? data.error ?? "招待の作成に失敗しました");
      }
    } catch (error) {
      console.error("Failed to create invite:", error);
      // サーバーが招待を作ってから応答が切れたこともあるので、履歴を読み直して今の状態を見せる (#2064 R5 と同じ型。
      // 読み直さないと、作れていた招待が履歴に出ず、もう一度送って同じ相手へ招待を重ねて送りうる)。フォームと入力は残す。
      // 読み直しが失敗したときは fetchInvites が履歴の「読み込めませんでした」を出す。
      // 成功のときの読み直しと同じく、読み直しの応答を待つあいだも書き込みの待ち (writeInFlightRef) を戻さない
      const reloaded = await fetchInvites();
      // 文は失敗したとは言わない (読み直した履歴で招待が作れていることもあるため。#2080 U4)。読み直しの結果で案内を出し分ける
      setSubmitError(orgWriteNoResponseMessage(ORG_WRITE_OPERATION.inviteCreate, reloaded ? "reloaded" : "reload_failed"));
    } finally {
      writeInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    // 招待の送信 (とその読み直し) の応答を待つあいだも送らない (writeInFlightRef)
    if (writeInFlightRef.current) return;
    if (!confirm("この招待を取り消しますか？")) return;

    writeInFlightRef.current = true;
    setRevokingId(inviteId);
    try {
      const res = await fetch(`/api/org/invites/${inviteId}/revoke`, {
        method: "POST",
      });

      if (res.ok) {
        // 読み直し (取り消した招待が「取消済」になり、取消のボタンが消える) まで待ってからボタンを戻す
        await fetchInvites();
      } else {
        // 本文が JSON でない失敗 (プロキシの 502 など) でも、取り消せなかったことを知らせる (黙って捨てない)
        const data = await res.json().catch(() => null);
        alert(data?.error?.message ?? REVOKE_FAILURE_MESSAGE);
      }
    } catch (error) {
      console.error("Failed to revoke invite:", error);
      // サーバーが取消を済ませてから応答が切れたこともあるので、履歴を読み直す (#2064 R5 と同じ型。読み直さないと、
      // 取り消した招待が「保留中」のまま取消のボタンを出し、もう一度押すと失敗の文が出ていた)。
      // 読み直しが失敗したときは fetchInvites が履歴の「読み込めませんでした」を出す。
      // 成功のときの読み直しと同じく、読み直しの応答を待つあいだも書き込みの待ち (writeInFlightRef) を戻さない
      const reloaded = await fetchInvites();
      // 文は「取り消しに失敗しました」と言わない (読み直した履歴で取消が済んでいることもあるため。#2080 U4)。
      // 読み直しの結果が分かってから、その結果に合わせた案内を出す
      alert(orgWriteNoResponseMessage(ORG_WRITE_OPERATION.inviteRevoke, reloaded ? "reloaded" : "reload_failed"));
    } finally {
      writeInFlightRef.current = false;
      setRevokingId(null);
    }
  };

  // 履歴の読み込みをやり直す (読み込めなかったときの「再試行」)。
  // 書き込みとそのあとの読み直しの応答を待つあいだは送らない (#2059)。待つあいだに送ると、この読み込みが書き込みより前の履歴を読み、
  // 書き込みのあとの読み直しより後に届いたとき、その古い履歴で表示が上書きされ、作ったものが表示から消える (もう一度作って重複させうる)。
  // ボタンも isWriting で止める。ref は再描画の前に押されたとき (ボタンがまだ止まっていない) の守り
  const retryLoad = () => {
    if (writeInFlightRef.current) return;
    setLoading(true);
    void fetchInvites();
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
      // 表に無い状態は内部の値を出さずに「-」 (#1912。組織の設定の画面のプランと状態の表示と同じ)
      default:          return { label: ORG_UNKNOWN_VALUE_LABEL, className: "bg-gray-100 text-gray-600" };
    }
  };

  const roleLabel = (role: string) => {
    switch (role) {
      case "owner":  return "オーナー";
      case "admin":  return "管理者";
      case "member": return "メンバー";
      // 表に無い役割・役割の無い応答は内部の値を出さずに「-」(状態の札と同じ。#1912)
      default:       return ORG_UNKNOWN_VALUE_LABEL;
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
            <div data-testid="invite-submit-error" className="rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-600">
              {submitError}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={isWriting}
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
        {loadError ? (
          <div
            role="alert"
            data-testid="invite-load-error"
            className="p-6 flex items-center justify-between gap-3 text-sm text-red-700 bg-red-50"
          >
            <span>{loadError}</span>
            <button
              type="button"
              onClick={retryLoad}
              disabled={isWriting}
              className="shrink-0 px-3 py-1.5 bg-white border border-red-300 rounded-lg text-red-700 hover:bg-red-100 transition-colors disabled:opacity-50"
            >
              再試行
            </button>
          </div>
        ) : (
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
                      disabled={isWriting}
                      className="px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm hover:bg-red-100 transition-colors disabled:opacity-50"
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
        )}
      </div>
    </div>
  );
}

// 状態は API の status を先に見る (取り消し・拒否された招待を「保留中」にしない)。
// 期限を過ぎた pending は「期限切れ」(API も同じく 'expired' にして返す)。status が無い応答だけ isAccepted / isExpired で決める
function getStatus(i: Record<string, unknown>): string {
  if (typeof i.status === "string" && i.status) {
    return i.status === "pending" && i.isExpired === true ? "expired" : i.status;
  }
  if (i.isAccepted) return "accepted";
  if (i.isExpired) return "expired";
  return "pending";
}
