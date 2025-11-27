"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";

interface UserBasic {
  id: string;
  nickname: string;
  role: string;
  ageGroup: string;
  gender: string;
  isBanned: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface UserDetail {
  user: {
    id: string;
    nickname: string;
    ageGroup: string;
    gender: string;
    role: string;
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
  inquiries: { id: string; inquiryType: string; subject: string; status: string; createdAt: string }[];
  notes: { id: string; note: string; createdAt: string; adminName?: string }[];
}

function SupportUsersContent() {
  const searchParams = useSearchParams();
  const initialUserId = searchParams.get("id");
  
  const [users, setUsers] = useState<UserBasic[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(initialUserId);
  const [userDetail, setUserDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const fetchUsers = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchQuery) params.set("q", searchQuery);
      params.set("limit", "50");

      const res = await fetch(`/api/admin/users?${params}`);
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
      }
    } catch (error) {
      console.error("Failed to fetch users:", error);
    } finally {
      setLoading(false);
    }
  }, [searchQuery]);

  const fetchUserDetail = useCallback(async (userId: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/support/users/${userId}`);
      if (res.ok) {
        const data = await res.json();
        setUserDetail(data);
      }
    } catch (error) {
      console.error("Failed to fetch user detail:", error);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    if (selectedUserId) {
      fetchUserDetail(selectedUserId);
    } else {
      setUserDetail(null);
    }
  }, [selectedUserId, fetchUserDetail]);

  const handleAddNote = async () => {
    if (!newNote.trim() || !selectedUserId) return;
    
    setAddingNote(true);
    try {
      const res = await fetch(`/api/support/users/${selectedUserId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: newNote }),
      });

      if (res.ok) {
        setNewNote("");
        fetchUserDetail(selectedUserId);
      }
    } catch (error) {
      console.error("Failed to add note:", error);
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
                  onClick={() => setSelectedUserId(user.id)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-gray-800">{user.nickname}</p>
                        {user.isBanned && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                            BAN
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-500 mt-0.5">
                        {user.ageGroup} / {user.gender === "male" ? "男性" : user.gender === "female" ? "女性" : "その他"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-gray-400">
                        最終ログイン: {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString('ja-JP') : "-"}
                      </p>
                    </div>
                  </div>
                </motion.div>
              ))}
              {users.length === 0 && (
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
                      <h2 className="text-lg font-bold text-gray-800">{userDetail.user.nickname}</h2>
                      <p className="text-sm text-gray-500">{userDetail.user.id.substring(0, 8)}...</p>
                    </div>
                    <button
                      onClick={() => setSelectedUserId(null)}
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
                              {new Date(inq.createdAt).toLocaleDateString('ja-JP')} - {inq.status}
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
                            {new Date(note.createdAt).toLocaleDateString('ja-JP')}
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
                  </div>
                </>
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

