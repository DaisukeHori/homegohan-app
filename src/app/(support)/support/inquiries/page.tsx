"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

// 一覧の 1 件 (概要)。問い合わせ本文と管理者メモは、詳細 (GET /api/admin/inquiries/[id]) でだけ返る
interface InquirySummary {
  id: string;
  userId: string | null;
  userName: string | null;
  inquiryType: string;
  email: string;
  subject: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

// 詳細パネルの 1 件。message / adminNotes は詳細を取得するまで null
interface Inquiry extends InquirySummary {
  message: string | null;
  adminNotes: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  general: "一般",
  support: "サポート",
  bug: "バグ報告",
  feature: "機能要望",
};

const STATUS_OPTIONS = [
  { value: "pending", label: "未対応", color: "bg-yellow-100 text-yellow-700" },
  { value: "in_progress", label: "対応中", color: "bg-blue-100 text-blue-700" },
  { value: "resolved", label: "解決済", color: "bg-green-100 text-green-700" },
  { value: "closed", label: "完了", color: "bg-gray-100 text-gray-600" },
];

// 一覧 API (GET /api/admin/inquiries) の 1 ページの件数
const PAGE_SIZE = 50;

// 管理者メモの最大文字数 (API の検証と同じ。超えると API が 400 を返す)
const ADMIN_NOTES_MAX_LENGTH = 5000;

// 失敗の理由 (API の error.message) があれば添えて、なければ HTTP ステータスを添える
async function describeFailure(res: Response, summary: string): Promise<string> {
  try {
    const body = await res.json();
    const message = body?.error?.message;
    if (typeof message === "string" && message) return `${summary}（${message}）`;
  } catch {
    // 本文が JSON でなければ HTTP ステータスで知らせる
  }
  return `${summary}（HTTP ${res.status}）`;
}

export default function SupportInquiriesPage() {
  const [inquiries, setInquiries] = useState<InquirySummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedInquiry, setSelectedInquiry] = useState<Inquiry | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [adminNote, setAdminNote] = useState("");
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  // 絞り込みを素早く切り替えたとき、古いリクエストの結果で一覧を上書きしないための連番
  const requestSeq = useRef(0);
  // 問い合わせを素早く選び直したとき、古い詳細の結果でパネルを上書きしないための連番
  const detailSeq = useRef(0);

  // nextPage = 1 は一覧の取り直し、2 以降は「さらに読み込む」(末尾に追加)
  const fetchInquiries = useCallback(async (nextPage = 1) => {
    const append = nextPage > 1;
    const seq = ++requestSeq.current;
    if (append) setLoadingMore(true);
    try {
      const params = new URLSearchParams({ page: String(nextPage), limit: String(PAGE_SIZE) });
      if (filterStatus) params.set("status", filterStatus);

      const res = await fetch(`/api/admin/inquiries?${params}`);
      if (seq !== requestSeq.current) return;
      if (!res.ok) {
        // 失敗を「該当する問い合わせはありません」と見分けられるよう、エラーとして表示する (#1121)
        const message = await describeFailure(res, "問い合わせを取得できませんでした");
        if (seq !== requestSeq.current) return; // 本文を読んでいる間に新しい取得が始まっていたら、古い失敗は捨てる
        setLoadError(message);
        if (!append) {
          setInquiries([]);
          setTotal(null);
          setHasMore(false);
        }
        return;
      }
      const data = await res.json();
      if (seq !== requestSeq.current) return;
      const fetched: InquirySummary[] = data.inquiries ?? [];
      setLoadError(null);
      setInquiries((prev) =>
        append ? [...prev, ...fetched.filter((item) => !prev.some((p) => p.id === item.id))] : fetched
      );
      setTotal(typeof data.total === "number" ? data.total : null);
      setHasMore(typeof data.total === "number" && nextPage * PAGE_SIZE < data.total);
      setPage(nextPage);
    } catch (error) {
      console.error("Failed to fetch inquiries:", error);
      if (seq !== requestSeq.current) return;
      setLoadError("問い合わせを取得できませんでした（通信エラー）");
      if (!append) {
        setInquiries([]);
        setTotal(null);
        setHasMore(false);
      }
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [filterStatus]);

  useEffect(() => {
    fetchInquiries();
  }, [fetchInquiries]);

  // 問い合わせを開く。概要はすぐ出し、本文と管理者メモは詳細 API から取る。
  // 詳細を取得した時点で、誰がどの問い合わせを見たかが API 側で監査ログに記録される。
  const openInquiry = useCallback(async (summary: InquirySummary) => {
    const seq = ++detailSeq.current;
    setSelectedInquiry({ ...summary, message: null, adminNotes: null });
    setAdminNote("");
    setUpdateError(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/inquiries/${summary.id}`);
      if (seq !== detailSeq.current) return;
      if (!res.ok) {
        const message = await describeFailure(res, "問い合わせの内容を取得できませんでした");
        if (seq !== detailSeq.current) return; // 本文を読んでいる間に選び直し・閉じられていたら、古い失敗は捨てる
        setDetailError(message);
        return;
      }
      const data = await res.json();
      if (seq !== detailSeq.current) return;
      setSelectedInquiry(data.inquiry);
      setAdminNote(data.inquiry.adminNotes || "");
    } catch (error) {
      console.error("Failed to fetch inquiry:", error);
      if (seq !== detailSeq.current) return;
      setDetailError("問い合わせの内容を取得できませんでした（通信エラー）");
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, []);

  const closeInquiry = () => {
    detailSeq.current += 1; // 取得中の詳細があっても、閉じたあとの結果は捨てる
    setSelectedInquiry(null);
    setDetailLoading(false);
    setDetailError(null);
    setUpdateError(null);
  };

  const handleStatusUpdate = async (inquiryId: string, newStatus: string) => {
    setUpdating(true);
    setUpdateError(null);
    try {
      const res = await fetch(`/api/admin/inquiries/${inquiryId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: newStatus,
          adminNotes: adminNote || undefined,
        }),
      });

      if (!res.ok) {
        // 更新できていないのに、画面だけ新しいステータスに見えないようにする (#1121)
        setUpdateError(await describeFailure(res, "更新に失敗しました"));
        return;
      }

      const data = await res.json().catch(() => null);
      await fetchInquiries();
      if (selectedInquiry?.id === inquiryId) {
        setSelectedInquiry(prev => {
          if (!prev) return null;
          // API が返した更新後の問い合わせ (本文・メモ・resolvedAt なども最新) があればそれを使う
          if (data?.inquiry) return { ...prev, ...data.inquiry };
          return { ...prev, status: newStatus, adminNotes: adminNote || prev.adminNotes };
        });
        // 管理者メモの入力欄は、保存された内容に合わせる
        setAdminNote(data?.inquiry ? (data.inquiry.adminNotes || "") : adminNote);
      }
    } catch (error) {
      console.error("Failed to update inquiry:", error);
      setUpdateError("更新に失敗しました（通信エラー）");
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // 本文と管理者メモを取得できている (メモの編集・ステータス変更をしてよい) 状態
  const detailReady = !detailLoading && !detailError;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">問い合わせ管理</h1>
          <p className="text-gray-500 mt-1">
            {loadError ? "問い合わせを表示できません" : `${total ?? inquiries.length}件の問い合わせ`}
          </p>
        </div>
        
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-4 py-2 bg-white border border-gray-200 rounded-xl text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500"
        >
          <option value="">すべてのステータス</option>
          {STATUS_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="flex gap-6">
        {/* Inquiry List */}
        <div className="flex-1 bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          {loadError && (
            <div
              role="alert"
              className="bg-red-50 border-b border-red-200 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-4"
            >
              <span>{loadError}</span>
              <button
                onClick={() => fetchInquiries()}
                className="underline whitespace-nowrap hover:text-red-900"
              >
                再読み込み
              </button>
            </div>
          )}
          <div className="divide-y divide-gray-50 max-h-[calc(100vh-250px)] overflow-y-auto">
            {inquiries.map((inquiry) => (
              <motion.div
                key={inquiry.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className={`p-4 cursor-pointer transition-colors ${
                  selectedInquiry?.id === inquiry.id ? "bg-teal-50" : "hover:bg-gray-50"
                }`}
                onClick={() => {
                  // 更新している間は選び直さない (更新の結果を別の問い合わせのパネルに書き込まないため)
                  if (!updating) openInquiry(inquiry);
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    STATUS_OPTIONS.find(s => s.value === inquiry.status)?.color
                  }`}>
                    {STATUS_OPTIONS.find(s => s.value === inquiry.status)?.label}
                  </span>
                  <span className="text-xs text-gray-400">
                    {TYPE_LABELS[inquiry.inquiryType] || inquiry.inquiryType}
                  </span>
                </div>
                <p className="font-medium text-gray-800 line-clamp-1">{inquiry.subject}</p>
                <div className="flex justify-between items-center mt-1">
                  <p className="text-sm text-gray-500">{inquiry.userName || inquiry.email}</p>
                  <p className="text-xs text-gray-400">
                    {new Date(inquiry.createdAt).toLocaleDateString('ja-JP')}
                  </p>
                </div>
              </motion.div>
            ))}
            {/* 取得に失敗したときは上のエラー表示だけを出す (「該当なし」と誤解させない) */}
            {!loadError && inquiries.length === 0 && (
              <div className="p-8 text-center text-gray-400">
                該当する問い合わせはありません
              </div>
            )}
            {hasMore && (
              <button
                onClick={() => fetchInquiries(page + 1)}
                disabled={loadingMore}
                className="w-full p-4 text-sm font-medium text-teal-600 hover:bg-gray-50 disabled:opacity-50"
              >
                {loadingMore ? "読み込み中..." : "さらに読み込む"}
              </button>
            )}
          </div>
        </div>

        {/* Detail Panel */}
        <AnimatePresence>
          {selectedInquiry && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="w-96 bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-6"
            >
              <div className="flex justify-between items-start">
                <div>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                    STATUS_OPTIONS.find(s => s.value === selectedInquiry.status)?.color
                  }`}>
                    {STATUS_OPTIONS.find(s => s.value === selectedInquiry.status)?.label}
                  </span>
                  <h2 className="text-lg font-bold text-gray-800 mt-2">{selectedInquiry.subject}</h2>
                </div>
                <button
                  onClick={closeInquiry}
                  disabled={updating}
                  className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">送信者</span>
                  <span className="text-gray-800">{selectedInquiry.userName || selectedInquiry.email}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">種別</span>
                  <span className="text-gray-800">{TYPE_LABELS[selectedInquiry.inquiryType]}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">受信日時</span>
                  <span className="text-gray-800">
                    {new Date(selectedInquiry.createdAt).toLocaleString('ja-JP')}
                  </span>
                </div>
              </div>

              <div>
                <p className="text-sm text-gray-500 mb-2">内容</p>
                {detailError ? (
                  <div
                    role="alert"
                    className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm flex items-center justify-between gap-3"
                  >
                    <span>{detailError}</span>
                    <button
                      onClick={() => openInquiry(selectedInquiry)}
                      className="underline whitespace-nowrap hover:text-red-900"
                    >
                      再試行
                    </button>
                  </div>
                ) : detailLoading ? (
                  <div className="bg-gray-50 rounded-xl p-4 text-gray-400">読み込み中...</div>
                ) : (
                  <div className="bg-gray-50 rounded-xl p-4 text-gray-700 whitespace-pre-wrap">
                    {selectedInquiry.message}
                  </div>
                )}
              </div>

              <div>
                <p className="text-sm text-gray-500 mb-2">管理者メモ</p>
                {/* 既存のメモを読み込むまでは入力させない (見えていないメモを上書きしないため) */}
                <textarea
                  value={adminNote}
                  onChange={(e) => setAdminNote(e.target.value)}
                  disabled={!detailReady}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-700 resize-none focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50"
                  rows={3}
                  maxLength={ADMIN_NOTES_MAX_LENGTH}
                  placeholder="対応メモを入力..."
                />
              </div>

              <div>
                <p className="text-sm text-gray-500 mb-2">ステータス変更</p>
                <div className="grid grid-cols-2 gap-2">
                  {STATUS_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handleStatusUpdate(selectedInquiry.id, opt.value)}
                      disabled={updating || !detailReady || selectedInquiry.status === opt.value}
                      className={`px-3 py-2 rounded-xl text-sm font-medium transition-all ${
                        selectedInquiry.status === opt.value
                          ? "bg-teal-600 text-white"
                          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      } disabled:opacity-50`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {updateError && (
                  <div
                    role="alert"
                    className="mt-3 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm"
                  >
                    {updateError}
                  </div>
                )}
              </div>

              {selectedInquiry.userId && (
                <a
                  href={`/support/users?id=${selectedInquiry.userId}`}
                  className="block w-full py-3 bg-teal-600 text-white text-center rounded-xl font-medium hover:bg-teal-700 transition-colors"
                >
                  ユーザー詳細を見る
                </a>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

