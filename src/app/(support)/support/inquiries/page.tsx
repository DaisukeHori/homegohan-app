"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Inquiry {
  id: string;
  userId: string | null;
  userName: string | null;
  inquiryType: string;
  email: string;
  subject: string;
  message: string;
  status: string;
  adminNotes: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
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

export default function SupportInquiriesPage() {
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedInquiry, setSelectedInquiry] = useState<Inquiry | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [adminNote, setAdminNote] = useState("");
  const [updating, setUpdating] = useState(false);

  const fetchInquiries = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set("status", filterStatus);
      
      const res = await fetch(`/api/admin/inquiries?${params}`);
      if (res.ok) {
        const data = await res.json();
        setInquiries(data.inquiries);
      }
    } catch (error) {
      console.error("Failed to fetch inquiries:", error);
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  useEffect(() => {
    fetchInquiries();
  }, [fetchInquiries]);

  const handleStatusUpdate = async (inquiryId: string, newStatus: string) => {
    setUpdating(true);
    try {
      const res = await fetch(`/api/admin/inquiries/${inquiryId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: newStatus,
          adminNotes: adminNote || undefined,
        }),
      });

      if (res.ok) {
        await fetchInquiries();
        if (selectedInquiry?.id === inquiryId) {
          setSelectedInquiry(prev => prev ? { ...prev, status: newStatus, adminNotes: adminNote || prev.adminNotes } : null);
        }
        setAdminNote("");
      }
    } catch (error) {
      console.error("Failed to update inquiry:", error);
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

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">問い合わせ管理</h1>
          <p className="text-gray-500 mt-1">{inquiries.length}件の問い合わせ</p>
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
                  setSelectedInquiry(inquiry);
                  setAdminNote(inquiry.adminNotes || "");
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
            {inquiries.length === 0 && (
              <div className="p-8 text-center text-gray-400">
                該当する問い合わせはありません
              </div>
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
                  onClick={() => setSelectedInquiry(null)}
                  className="text-gray-400 hover:text-gray-600"
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
                <div className="bg-gray-50 rounded-xl p-4 text-gray-700 whitespace-pre-wrap">
                  {selectedInquiry.message}
                </div>
              </div>

              <div>
                <p className="text-sm text-gray-500 mb-2">管理者メモ</p>
                <textarea
                  value={adminNote}
                  onChange={(e) => setAdminNote(e.target.value)}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-700 resize-none focus:outline-none focus:ring-2 focus:ring-teal-500"
                  rows={3}
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
                      disabled={updating || selectedInquiry.status === opt.value}
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

