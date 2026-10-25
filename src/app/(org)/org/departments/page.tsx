"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { extractApiErrorMessage } from "@/lib/admin/api-error-message";

interface Department {
  id: string;
  name: string;
  parentId: string | null;
  managerId: string | null;
  displayOrder: number;
  memberCount: number;
  createdAt: string;
}

/** 部署の追加・更新・削除が失敗したときの文の頭 (後ろに理由を添える) */
const CREATE_FAILURE_SUMMARY = "部署を追加できませんでした";
const UPDATE_FAILURE_SUMMARY = "部署を更新できませんでした";
const DELETE_FAILURE_SUMMARY = "部署を削除できませんでした";

/**
 * 失敗の応答から画面に出す文 (「<操作>（<理由>）」)。理由は本文の文 (API の error.message)、読めなければ HTTP ステータス。
 * 失敗を黙って捨てない (名前の誤り (400)・参照されている部署の削除 (409)・500 のとき、操作が効いたか分からなくなるため)
 */
async function failureMessageOf(res: Response, summary: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  return `${summary}（${extractApiErrorMessage(body) ?? `HTTP ${res.status}`}）`;
}

export default function OrgDepartmentsPage() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingDept, setEditingDept] = useState<Department | null>(null);
  const [formName, setFormName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // 追加・更新・削除が失敗したときの文
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchDepartments = useCallback(async () => {
    try {
      const res = await fetch("/api/org/departments");
      if (res.ok) {
        const data = await res.json();
        setDepartments(data.departments);
      }
    } catch (error) {
      console.error("Failed to fetch departments:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDepartments();
  }, [fetchDepartments]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) return;

    const summary = editingDept ? UPDATE_FAILURE_SUMMARY : CREATE_FAILURE_SUMMARY;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const res = editingDept
        ? // 更新
          await fetch("/api/org/departments", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: editingDept.id, name: formName }),
          })
        : // 新規作成
          await fetch("/api/org/departments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: formName }),
          });
      if (!res.ok) {
        // 保存できていないことを出し、フォームと入力した名前は残す (直してもう一度送れるように)
        setErrorMessage(await failureMessageOf(res, summary));
        return;
      }
      fetchDepartments();
      resetForm();
    } catch (error) {
      console.error("Failed to save department:", error);
      setErrorMessage(`${summary}（通信エラー）`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (deptId: string) => {
    if (!confirm("この部署を削除しますか？")) return;

    setErrorMessage(null);
    try {
      const res = await fetch(`/api/org/departments?id=${deptId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setErrorMessage(await failureMessageOf(res, DELETE_FAILURE_SUMMARY));
        return;
      }
      fetchDepartments();
    } catch (error) {
      console.error("Failed to delete department:", error);
      setErrorMessage(`${DELETE_FAILURE_SUMMARY}（通信エラー）`);
    }
  };

  // フォームを閉じる・開き直すときは、前の操作の失敗の文を残さない
  const resetForm = () => {
    setShowForm(false);
    setEditingDept(null);
    setFormName("");
    setErrorMessage(null);
  };

  const startEdit = (dept: Department) => {
    setErrorMessage(null);
    setEditingDept(dept);
    setFormName(dept.name);
    setShowForm(true);
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
          <h1 className="text-2xl font-bold text-gray-800">部署管理</h1>
          <p className="text-gray-500 mt-1">{departments.length}件の部署</p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(true); }}
          className="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
        >
          + 部署を追加
        </button>
      </div>

      {errorMessage && (
        <div
          role="alert"
          data-testid="department-error"
          className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm"
        >
          {errorMessage}
        </div>
      )}

      <AnimatePresence>
        {showForm && (
          <motion.form
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            onSubmit={handleSubmit}
            className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                部署名
              </label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                required
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="例: 営業部"
              />
            </div>
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={submitting}
                className="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {submitting ? "保存中..." : editingDept ? "更新" : "追加"}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="px-6 py-3 bg-gray-100 text-gray-700 rounded-xl font-medium hover:bg-gray-200 transition-colors"
              >
                キャンセル
              </button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {departments.map((dept) => (
          <motion.div
            key={dept.id}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100"
          >
            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-lg font-bold text-gray-800">{dept.name}</h3>
                <p className="text-sm text-gray-500 mt-1">{dept.memberCount}名</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => startEdit(dept)}
                  className="p-2 text-gray-400 hover:text-blue-600 transition-colors"
                >
                  ✏️
                </button>
                <button
                  onClick={() => handleDelete(dept.id)}
                  className="p-2 text-gray-400 hover:text-red-600 transition-colors"
                >
                  🗑
                </button>
              </div>
            </div>
          </motion.div>
        ))}
        {departments.length === 0 && (
          <div className="col-span-full text-center text-gray-400 py-12">
            部署がありません
          </div>
        )}
      </div>
    </div>
  );
}

