"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  extractApiErrorMessage,
  operationFailureMessage,
  operationNetworkFailureMessage,
} from "@/lib/admin/api-error-message";

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
/** 部署の一覧を読み込めなかったときの文の頭 (後ろに理由を添える)。空の一覧 (「部署がありません」) と見分けるために出す (#2050) */
const LOAD_FAILURE_SUMMARY = "部署の一覧を読み込めませんでした";

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
  // 一覧を読み込めなかったときの文。あるあいだは一覧と「部署がありません」の代わりにこの文と「再試行」を出す
  // (読めなかったのを部署が無いと見せない。管理者が同じ名前の部署を作り直さないように。#2050)
  const [loadError, setLoadError] = useState<string | null>(null);
  // 削除の応答を待っている部署の id。待つあいだは削除のボタンを止める
  // (二度押しで 2 本目の DELETE を送ると、削除できているのに 404 で「部署を削除できませんでした」が出るため。#2050)
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 追加・更新か削除のどちらかの書き込みとそのあとの読み直しの応答を待っているか (10/26 の整合ゲート 1026e。#2050)。
  // 書き込みのあとの読み直しは一覧を丸ごと差し替えるので、2 つの書き込みを重ねると、先に送った読み直しの応答が後に届いたとき、
  // その古い一覧 (例: 消した部署がまだある一覧) で表示が上書きされ、消した部署の削除をもう一度押せてしまう
  // (#2053 のクーポン・機能パッケージと同じ型)。待つあいだは追加・更新と削除のボタン (と一覧の「再試行」。#2059) を止め、押されても送らない。
  // ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り
  const writeInFlightRef = useRef(false);
  const isWriting = submitting || deletingId !== null;

  const fetchDepartments = useCallback(async () => {
    try {
      const res = await fetch("/api/org/departments");
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        setLoadError(operationFailureMessage(LOAD_FAILURE_SUMMARY, res.status, body));
        return;
      }
      const data = await res.json();
      setDepartments(data.departments);
      setLoadError(null);
    } catch (error) {
      console.error("Failed to fetch departments:", error);
      setLoadError(operationNetworkFailureMessage(LOAD_FAILURE_SUMMARY));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDepartments();
  }, [fetchDepartments]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 削除 (とその読み直し) の応答を待つあいだは送らない (writeInFlightRef)
    if (!formName.trim() || writeInFlightRef.current) return;

    const summary = editingDept ? UPDATE_FAILURE_SUMMARY : CREATE_FAILURE_SUMMARY;
    writeInFlightRef.current = true;
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
      resetForm();
      // 読み直しの応答まで待ってからボタンを戻す (待たずに次の書き込みを送ると、この読み直しの古い一覧で上書きされうるため)
      await fetchDepartments();
    } catch (error) {
      console.error("Failed to save department:", error);
      setErrorMessage(`${summary}（通信エラー）`);
      // サーバーが追加・更新を済ませてから応答が切れたこともあるので、一覧を読み直して今の状態を見せる (#2064 R5 と同じ型。
      // 読み直さないと、追加できていた部署が一覧に出ず、もう一度送って同じ部署を重ねて作りうる)。フォームと入力した名前は残す。
      // 読み直しが失敗したときは fetchDepartments が一覧の「読み込めませんでした」を出す。
      // 成功のときの読み直しと同じく、読み直しの応答を待つあいだも書き込みの待ち (writeInFlightRef) を戻さない
      await fetchDepartments();
    } finally {
      writeInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const handleDelete = async (deptId: string) => {
    // 追加・更新 (とその読み直し) の応答を待つあいだも送らない (writeInFlightRef)
    if (writeInFlightRef.current) return;
    if (!confirm("この部署を削除しますか？")) return;

    writeInFlightRef.current = true;
    setDeletingId(deptId);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/org/departments?id=${deptId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setErrorMessage(await failureMessageOf(res, DELETE_FAILURE_SUMMARY));
        return;
      }
      // 読み直し (消した部署が一覧から消える) まで待ってからボタンを戻す (戻した直後の押下で 2 本目を送らないように)
      await fetchDepartments();
    } catch (error) {
      console.error("Failed to delete department:", error);
      setErrorMessage(`${DELETE_FAILURE_SUMMARY}（通信エラー）`);
      // サーバーが削除を済ませてから応答が切れたこともあるので、一覧を読み直す (#2064 R5 と同じ型。読み直さないと、
      // 削除した部署が一覧に残り、もう一度削除を押すと 404 で「部署を削除できませんでした」が出ていた)。
      // 読み直しが失敗したときは fetchDepartments が一覧の「読み込めませんでした」を出す。
      // 成功のときの読み直しと同じく、読み直しの応答を待つあいだも書き込みの待ち (writeInFlightRef) を戻さない
      await fetchDepartments();
    } finally {
      writeInFlightRef.current = false;
      setDeletingId(null);
    }
  };

  // 一覧の読み込みをやり直す (読み込めなかったときの「再試行」)。
  // 書き込みとそのあとの読み直しの応答を待つあいだは送らない (#2059)。待つあいだに送ると、この読み込みが書き込みより前の一覧を読み、
  // 書き込みのあとの読み直しより後に届いたとき、その古い一覧で表示が上書きされ、作ったものが表示から消える (もう一度作って重複させうる)。
  // ボタンも isWriting で止める。ref は再描画の前に押されたとき (ボタンがまだ止まっていない) の守り
  const retryLoad = () => {
    if (writeInFlightRef.current) return;
    setLoading(true);
    void fetchDepartments();
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
          {/* 読み込めなかったときは件数を出さない (「0件」と見せない) */}
          {!loadError && <p className="text-gray-500 mt-1">{departments.length}件の部署</p>}
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
                disabled={isWriting}
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

      {loadError ? (
        <div
          role="alert"
          data-testid="department-load-error"
          className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm flex items-center justify-between gap-3"
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
                  disabled={isWriting}
                  className="p-2 text-gray-400 hover:text-red-600 transition-colors disabled:opacity-50"
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
      )}
    </div>
  );
}

