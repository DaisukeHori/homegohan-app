"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { normalizeProfileName } from "@/lib/profile-name";
import { inquiryStatusLabel } from "@/lib/admin/inquiry-labels";
import { UsersListResponseSchema, type UserListItem } from "@/lib/admin/users-schemas";
import {
  UNAUTHENTICATED_SCREEN_MESSAGE,
  forbiddenMessageOfResponse,
  operationFailureMessage,
  operationNetworkFailureMessage,
} from "@/lib/admin/api-error-message";

// 一覧に出す件数 (GET /api/admin/users の per_page。API の既定と同じ 50 件)
const USERS_PER_PAGE = 50;

const USERS_LOAD_ERROR = "ユーザー一覧を取得できませんでした。しばらくしてから、もう一度お試しください。";
/** メモの追加が失敗したときの文の頭 (後ろに理由を添える) */
const NOTE_ADD_FAILURE_SUMMARY = "メモを追加できませんでした";
/** 利用者の詳細を読み込めなかったときの文の頭 (後ろに理由を添える)。前の利用者の詳細を出したままにしないために出す (#2050) */
const DETAIL_LOAD_FAILURE_SUMMARY = "ユーザーの詳細を読み込めませんでした";
/** 401 (Unauthorized。ログインが切れた) の HTTP ステータス */
const HTTP_UNAUTHORIZED = 401;
/** 403 (Forbidden) の HTTP ステータス */
const HTTP_FORBIDDEN = 403;

/** 日時 (ISO 8601) を一覧の日付の表示にする。値が無ければ "-" */
function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString("ja-JP") : "-";
}

interface UserDetail {
  user: {
    id: string;
    nickname: string;
    ageGroup: string;
    gender: string;
    roles: string[] | null;
    organizationId: string | null;
    isBanned: boolean;
    bannedAt: string | null;
    bannedReason: string | null;
    lastLoginAt: string | null;
    loginCount: number;
    profileCompleteness: number;
    createdAt: string;
  };
  stats: {
    mealCount: number;
    aiSessionCount: number;
  };
  // GET /api/support/users/[id] は問い合わせとノートを DB の列名 (snake_case) のまま返す (モバイルアプリも同じ形を読む)
  inquiries: { id: string; inquiry_type: string; subject: string; status: string; created_at: string }[];
  notes: { id: string; note: string; created_at: string; admin_id: string }[];
}

function SupportUsersContent() {
  const searchParams = useSearchParams();
  const initialUserId = searchParams.get("id");
  
  // 一覧は GET /api/admin/users の応答の形 (UserListItem。鍵は snake_case) のまま持つ (#1717)
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(initialUserId);
  // いま選んでいる利用者の id (描画を待たずに読むための写し。選択は selectUser でだけ変える)。
  // 応答が届いた時点で別の利用者を選んでいたら、その応答で詳細の欄・メモの失敗の文を書かない (#2050)
  const selectedUserIdRef = useRef<string | null>(initialUserId);
  const [userDetail, setUserDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 詳細を読み込めなかったときの文
  const [detailError, setDetailError] = useState<string | null>(null);
  // 利用者を素早く選び直したとき、古い詳細の応答で詳細の欄を上書きしないための連番
  const detailSeq = useRef(0);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  // メモの追加が失敗したときの文 (失敗の応答を黙って捨てない)
  const [noteError, setNoteError] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchQuery) params.set("q", searchQuery);
      params.set("per_page", String(USERS_PER_PAGE));

      const res = await fetch(`/api/admin/users?${params}`);
      if (!res.ok) {
        // 取得できなかったことを「ユーザーが見つかりません」と見せない。
        // 401 は「しばらくしてから、もう一度お試しください」(USERS_LOAD_ERROR) ではなく、同じ画面の詳細の読み込み・メモの追加の 401
        // (operationFailureMessage) と同じ「ログインし直してください」(時間をおいても読めない。#2112 Z4)。
        // 403 は本文の理由の文 (二段階認証の確認が要る など) を捨てずに出す。それ以外の 403 と失敗は USERS_LOAD_ERROR (#1917)
        const message =
          res.status === HTTP_UNAUTHORIZED
            ? UNAUTHENTICATED_SCREEN_MESSAGE
            : res.status === HTTP_FORBIDDEN
              ? await forbiddenMessageOfResponse(res, USERS_LOAD_ERROR)
              : USERS_LOAD_ERROR;
        setUsers([]);
        setLoadError(message);
        return;
      }
      // 応答は { data: UserListItem[], meta } (route と同じスキーマで確かめる)。
      // 以前は data.users と camelCase の鍵で読んでいて、一覧が出なかった (#1717)
      const parsed = UsersListResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        console.error("Unexpected /api/admin/users response:", parsed.error.flatten());
        setUsers([]);
        setLoadError(USERS_LOAD_ERROR);
        return;
      }
      setUsers(parsed.data.data);
      setLoadError(null);
    } catch (error) {
      console.error("Failed to fetch users:", error);
      setUsers([]);
      setLoadError(USERS_LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, [searchQuery]);

  // 利用者を選ぶ・閉じる (null)。描画を待たずに読む写し (selectedUserIdRef) も同時に変える
  const selectUser = useCallback((userId: string | null) => {
    selectedUserIdRef.current = userId;
    setSelectedUserId(userId);
  }, []);

  const fetchUserDetail = useCallback(async (userId: string) => {
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await fetch(`/api/support/users/${userId}`);
      if (seq !== detailSeq.current) return;
      if (!res.ok) {
        // 読めなかった利用者の詳細の代わりに、前に出していた (別の) 利用者の詳細を残さない
        const body: unknown = await res.json().catch(() => null);
        if (seq !== detailSeq.current) return; // 本文を読んでいる間に選び直していたら、古い失敗は捨てる
        setUserDetail(null);
        setDetailError(operationFailureMessage(DETAIL_LOAD_FAILURE_SUMMARY, res.status, body));
        return;
      }
      const data = await res.json();
      if (seq !== detailSeq.current) return;
      setUserDetail(data);
    } catch (error) {
      console.error("Failed to fetch user detail:", error);
      if (seq !== detailSeq.current) return;
      setUserDetail(null);
      setDetailError(operationNetworkFailureMessage(DETAIL_LOAD_FAILURE_SUMMARY));
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    // 前の利用者のメモの追加の失敗の文と書きかけのメモは、別の利用者の詳細に残さない
    // (書きかけを残すと、前の利用者に宛てたメモを、いま選んだ利用者に追加してしまうため。#2050)
    setNoteError(null);
    setNewNote("");
    // 前の利用者の詳細は、選んだ利用者の詳細が届くまでも出さない
    setUserDetail(null);
    if (selectedUserId) {
      fetchUserDetail(selectedUserId);
    } else {
      // 閉じたら、読み込み中の詳細の応答も捨てる
      detailSeq.current += 1;
      setDetailLoading(false);
      setDetailError(null);
    }
  }, [selectedUserId, fetchUserDetail]);

  const handleAddNote = async () => {
    if (!newNote.trim() || !selectedUserId) return;
    // 送り先の利用者 (応答が届いた時点で別の利用者を選んでいたら、その応答で画面を書かない)
    const targetUserId = selectedUserId;
    const sentNote = newNote;
    const isStillSelected = () => selectedUserIdRef.current === targetUserId;

    setAddingNote(true);
    setNoteError(null);
    try {
      const res = await fetch(`/api/support/users/${targetUserId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: sentNote }),
      });

      if (!res.ok) {
        // 追加できていないことを画面に出し、入力したメモは残す (もう一度追加できるように)
        const body: unknown = await res.json().catch(() => null);
        if (!isStillSelected()) return;
        setNoteError(operationFailureMessage(NOTE_ADD_FAILURE_SUMMARY, res.status, body));
        return;
      }
      // 別の利用者を選んでいたら、その利用者の詳細の欄と書きかけのメモに触れない
      // (送った利用者の詳細を読み直すと、いま選んでいる利用者の欄が前の利用者で上書きされる。#2050)
      if (!isStillSelected()) return;
      // 入力欄は、送ったメモのままなら空にする (待つ間に書き直した・選び直して書いたメモは消さない)
      setNewNote((current) => (current === sentNote ? "" : current));
      fetchUserDetail(targetUserId);
    } catch (error) {
      console.error("Failed to add note:", error);
      if (!isStillSelected()) return;
      setNoteError(operationNetworkFailureMessage(NOTE_ADD_FAILURE_SUMMARY));
    } finally {
      setAddingNote(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    fetchUsers();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">ユーザー検索</h1>
        <p className="text-gray-500 mt-1">ユーザー情報の確認・メモの追加</p>
      </div>

      <form onSubmit={handleSearch} className="flex gap-3">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="ニックネーム・IDで検索..."
          className="flex-1 px-4 py-3 bg-white border border-gray-200 rounded-xl text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
        <button
          type="submit"
          className="px-6 py-3 bg-teal-600 text-white rounded-xl font-medium hover:bg-teal-700 transition-colors"
        >
          検索
        </button>
      </form>

      <div className="flex gap-6">
        {/* User List */}
        <div className="flex-1 bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="w-10 h-10 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="divide-y divide-gray-50 max-h-[calc(100vh-300px)] overflow-y-auto">
              {users.map((user) => (
                <motion.div
                  key={user.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className={`p-4 cursor-pointer transition-colors ${
                    selectedUserId === user.id ? "bg-teal-50" : "hover:bg-gray-50"
                  }`}
                  onClick={() => selectUser(user.id)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-gray-800">{normalizeProfileName(user.nickname) ?? "(名前なし)"}</p>
                        {user.is_banned && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                            BAN
                          </span>
                        )}
                      </div>
                      {/* 年代・性別は一覧の応答に無い (詳細のパネルに出す)。一覧には登録日を出す */}
                      <p className="text-sm text-gray-500 mt-0.5">
                        登録日: {formatDate(user.registered_at)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-gray-400">
                        最終ログイン: {formatDate(user.last_login_at)}
                      </p>
                    </div>
                  </div>
                </motion.div>
              ))}
              {loadError ? (
                <div role="alert" className="p-8 text-center text-red-600">
                  {loadError}
                </div>
              ) : users.length === 0 && (
                <div className="p-8 text-center text-gray-400">
                  ユーザーが見つかりません
                </div>
              )}
            </div>
          )}
        </div>

        {/* Detail Panel */}
        <AnimatePresence>
          {selectedUserId && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="w-96 bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-6 max-h-[calc(100vh-200px)] overflow-y-auto"
            >
              {detailLoading ? (
                <div className="flex items-center justify-center h-64">
                  <div className="w-8 h-8 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : userDetail ? (
                <>
                  <div className="flex justify-between items-start">
                    <div>
                      <h2 className="text-lg font-bold text-gray-800">{normalizeProfileName(userDetail.user.nickname) ?? "(名前なし)"}</h2>
                      <p className="text-sm text-gray-500">{userDetail.user.id.substring(0, 8)}...</p>
                    </div>
                    <button
                      onClick={() => selectUser(null)}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      ✕
                    </button>
                  </div>

                  {userDetail.user.isBanned && (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                      <p className="text-sm font-medium text-red-700">このユーザーはBANされています</p>
                      {userDetail.user.bannedReason && (
                        <p className="text-sm text-red-600 mt-1">{userDetail.user.bannedReason}</p>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-gray-50 rounded-xl p-4 text-center">
                      <p className="text-2xl font-bold text-teal-600">{userDetail.stats.mealCount}</p>
                      <p className="text-xs text-gray-500">食事記録</p>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-4 text-center">
                      <p className="text-2xl font-bold text-teal-600">{userDetail.stats.aiSessionCount}</p>
                      <p className="text-xs text-gray-500">AI相談(30日)</p>
                    </div>
                  </div>

                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">年代</span>
                      <span className="text-gray-800">{userDetail.user.ageGroup}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">性別</span>
                      <span className="text-gray-800">
                        {userDetail.user.gender === "male" ? "男性" : userDetail.user.gender === "female" ? "女性" : "その他"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">ログイン回数</span>
                      <span className="text-gray-800">{userDetail.user.loginCount}回</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">プロフィール完成度</span>
                      <span className="text-gray-800">{userDetail.user.profileCompleteness}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">登録日</span>
                      <span className="text-gray-800">
                        {new Date(userDetail.user.createdAt).toLocaleDateString('ja-JP')}
                      </span>
                    </div>
                  </div>

                  {/* Inquiries */}
                  {userDetail.inquiries.length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">問い合わせ履歴</p>
                      <div className="space-y-2">
                        {userDetail.inquiries.map((inq) => (
                          <div key={inq.id} className="bg-gray-50 rounded-lg p-3">
                            <p className="text-sm text-gray-800 line-clamp-1">{inq.subject}</p>
                            <p className="text-xs text-gray-500 mt-1">
                              {new Date(inq.created_at).toLocaleDateString('ja-JP')} - {inquiryStatusLabel(inq.status)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Notes */}
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">対応メモ</p>
                    <div className="space-y-2 mb-3">
                      {userDetail.notes.map((note) => (
                        <div key={note.id} className="bg-yellow-50 rounded-lg p-3">
                          <p className="text-sm text-gray-800 whitespace-pre-wrap">{note.note}</p>
                          <p className="text-xs text-gray-500 mt-1">
                            {new Date(note.created_at).toLocaleDateString('ja-JP')}
                          </p>
                        </div>
                      ))}
                      {userDetail.notes.length === 0 && (
                        <p className="text-sm text-gray-400">メモはありません</p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newNote}
                        onChange={(e) => setNewNote(e.target.value)}
                        placeholder="メモを追加..."
                        className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                      />
                      <button
                        onClick={handleAddNote}
                        disabled={addingNote || !newNote.trim()}
                        className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50 transition-colors"
                      >
                        追加
                      </button>
                    </div>
                    {noteError && (
                      <div
                        role="alert"
                        data-testid="note-add-error"
                        className="mt-2 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm"
                      >
                        {noteError}
                      </div>
                    )}
                  </div>
                </>
              ) : detailError ? (
                <div className="space-y-3">
                  <div className="flex justify-end">
                    <button
                      onClick={() => selectUser(null)}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      ✕
                    </button>
                  </div>
                  <div
                    role="alert"
                    data-testid="user-detail-load-error"
                    className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm"
                  >
                    {detailError}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedUserId) void fetchUserDetail(selectedUserId);
                    }}
                    className="px-3 py-1.5 bg-white border border-red-300 rounded-lg text-sm text-red-700 hover:bg-red-100 transition-colors"
                  >
                    再試行
                  </button>
                </div>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default function SupportUsersPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <SupportUsersContent />
    </Suspense>
  );
}

