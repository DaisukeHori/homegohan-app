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
  resolvedAt: string | null;
}

const STATUS_OPTIONS = [
  { value: "pending", label: "未対応", color: "bg-yellow-100 text-yellow-700" },
  { value: "in_progress", label: "対応中", color: "bg-blue-100 text-blue-700" },
  { value: "resolved", label: "解決済", color: "bg-green-100 text-green-700" },
  { value: "closed", label: "完了", color: "bg-gray-100 text-gray-600" },
];

export default function AdminInquiriesPage() {
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedInquiry, setSelectedInquiry] = useState<Inquiry | null>(null);
  const [filterStatus, setFilterStatus] = useState("");
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
        body: JSON.stringify({ status: newStatus, adminNotes: adminNote || undefined }),
      });

      if (res.ok) {
        await fetchInquiries();
        if (selectedInquiry?.id === inquiryId) {
          setSelectedInquiry(prev => prev ? { ...prev, status: newStatus } : null);
        }
      }
    } catch (error) {
      console.error("Failed to update:", error);
    } finally {
      setUpdating(false);
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
        <h1 className="text-xl font-bold text-gray-800">問い合わせ管理</h1>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-4 py-2 bg-white border border-gray-200 rounded-lg"
        >
          <option value="">すべて</option>
          {STATUS_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="flex gap-6">
        <div className="flex-1 bg-white rounded-xl overflow-hidden">
          <div className="divide-y max-h-[600px] overflow-y-auto">
            {inquiries.map((inq) => (
              <div
                key={inq.id}
                className={`p-4 cursor-pointer transition-colors ${selectedInquiry?.id === inq.id ? "bg-orange-50" : "hover:bg-gray-50"}`}
                onClick={() => { setSelectedInquiry(inq); setAdminNote(inq.adminNotes || ""); }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_OPTIONS.find(s => s.value === inq.status)?.color}`}>
                    {STATUS_OPTIONS.find(s => s.value === inq.status)?.label}
                  </span>
                </div>
                <p className="font-medium text-gray-800 line-clamp-1">{inq.subject}</p>
                <p className="text-sm text-gray-500">{inq.userName || inq.email}</p>
              </div>
            ))}
            {inquiries.length === 0 && <div className="p-8 text-center text-gray-400">問い合わせがありません</div>}
          </div>
        </div>

        <AnimatePresence>
          {selectedInquiry && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="w-96 bg-white rounded-xl p-6 space-y-4"
            >
              <div className="flex justify-between">
                <h2 className="font-bold text-gray-800">{selectedInquiry.subject}</h2>
                <button onClick={() => setSelectedInquiry(null)} className="text-gray-400">✕</button>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-700 whitespace-pre-wrap">
                {selectedInquiry.message}
              </div>
              <textarea
                value={adminNote}
                onChange={(e) => setAdminNote(e.target.value)}
                placeholder="管理者メモ..."
                className="w-full px-3 py-2 border rounded-lg resize-none"
                rows={3}
              />
              <div className="grid grid-cols-2 gap-2">
                {STATUS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleStatusUpdate(selectedInquiry.id, opt.value)}
                    disabled={updating}
                    className={`px-3 py-2 rounded-lg text-sm font-medium ${selectedInquiry.status === opt.value ? "bg-orange-500 text-white" : "bg-gray-100"}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

