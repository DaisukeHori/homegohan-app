"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  ORG_CONTACT_EMAIL_MAX_LENGTH,
  ORG_CONTACT_NAME_MAX_LENGTH,
  ORG_EMPLOYEE_COUNT_MAX,
  ORG_EMPLOYEE_COUNT_MIN,
  ORG_INDUSTRY_MAX_LENGTH,
  ORG_SETTINGS_NAME_MAX_LENGTH,
  buildOrgSettingsUpdateBody,
  orgSettingsFormValuesOf,
  type OrgSettingsData,
  type OrgSettingsFormValues,
} from "@homegohan/shared";
import { ORG_PLAN_OPERATOR_ONLY_NOTE, orgPlanLabel, orgSubscriptionStatusLabel } from "@/lib/org-plans";

const EMPTY_FORM: OrgSettingsFormValues = {
  name: "",
  industry: "",
  employeeCount: "",
  contactEmail: "",
  contactName: "",
};

const LOAD_ERROR_MESSAGE = "組織の設定を読み込めませんでした。ページを読み込み直してください";
const SAVE_ERROR_MESSAGE = "設定を保存できませんでした。もう一度お試しください";
const SAVE_NETWORK_ERROR_MESSAGE = "設定を保存できませんでした。通信状況を確認して、もう一度お試しください";
const VALIDATION_ERROR_MESSAGE = "入力内容を確認してください (連絡先メールはメールアドレスの形で、各項目は文字数の上限までで入力してください)";

/** API のエラー本文から、画面に出す文を取り出す (本文が読めなければ既定の文) */
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error?.code === "VALIDATION_ERROR") return VALIDATION_ERROR_MESSAGE;
    if (typeof body?.error?.message === "string") return body.error.message;
  } catch {
    // 本文が JSON でない
  }
  return fallback;
}

/**
 * GET /api/org/settings は { data: 組織の設定 } を返す (snake_case。docs/design/cross/04-api-conventions.md §12)。
 * 送る本文は @homegohan/shared の buildOrgSettingsUpdateBody だけで作る (route が受け取るキーとの一致は
 * tests/org-settings-keys.test.tsx が検査する。#1735: 以前は route が知らないキーを送り、捨てられても「保存しました」と出していた)
 */
export default function OrgSettingsPage() {
  const [org, setOrg] = useState<OrgSettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<OrgSettingsFormValues>(EMPTY_FORM);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const applyOrg = (data: OrgSettingsData) => {
    setOrg(data);
    setFormData(orgSettingsFormValuesOf(data));
  };

  useEffect(() => {
    const fetchOrg = async () => {
      try {
        const res = await fetch("/api/org/settings");
        if (!res.ok) {
          setErrorMessage(await readErrorMessage(res, LOAD_ERROR_MESSAGE));
          return;
        }
        const body: { data?: OrgSettingsData } = await res.json();
        if (!body.data) {
          setErrorMessage(LOAD_ERROR_MESSAGE);
          return;
        }
        applyOrg(body.data);
      } catch (error) {
        console.error("Failed to fetch org:", error);
        setErrorMessage(LOAD_ERROR_MESSAGE);
      } finally {
        setLoading(false);
      }
    };
    fetchOrg();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 保存されている値を読めていないときは送らない。空の入力欄のまま送ると、業種・従業員数・連絡先を null で上書きして消してしまう
    if (!org) return;
    setErrorMessage(null);
    setSavedMessage(null);

    const built = buildOrgSettingsUpdateBody(formData);
    if (!built.ok) {
      setErrorMessage(built.message);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/org/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.body),
      });

      if (!res.ok) {
        setErrorMessage(await readErrorMessage(res, SAVE_ERROR_MESSAGE));
        return;
      }
      const body: { data?: OrgSettingsData } = await res.json();
      // 画面には、保存された値 (route が返した行) を出す
      if (body.data) applyOrg(body.data);
      setSavedMessage("設定を保存しました");
    } catch (error) {
      console.error("Failed to save settings:", error);
      setErrorMessage(SAVE_NETWORK_ERROR_MESSAGE);
    } finally {
      setSaving(false);
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
      <div>
        <h1 className="text-2xl font-bold text-gray-800">組織設定</h1>
        <p className="text-gray-500 mt-1">組織の基本情報を編集</p>
      </div>

      {org && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100"
          >
            <p className="text-sm text-gray-500">プラン</p>
            <p className="text-xl font-bold text-gray-800">{orgPlanLabel(org.plan)}</p>
            {/* プランは表示だけ (組織の管理者は変えられない。変えるのは運営の画面。#1912) */}
            <p className="mt-1 text-xs text-gray-500">{ORG_PLAN_OPERATOR_ONLY_NOTE}</p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100"
          >
            <p className="text-sm text-gray-500">ステータス</p>
            <p className="text-xl font-bold text-gray-800">{orgSubscriptionStatusLabel(org.subscription_status)}</p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100"
          >
            <p className="text-sm text-gray-500">有効期限</p>
            <p className="text-xl font-bold text-gray-800">
              {org.subscription_expires_at
                ? new Date(org.subscription_expires_at).toLocaleDateString('ja-JP')
                : "-"
              }
            </p>
          </motion.div>
        </div>
      )}

      {errorMessage && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          {errorMessage}
        </div>
      )}
      {savedMessage && (
        <div role="status" className="bg-green-50 border border-green-200 text-green-700 rounded-xl px-4 py-3 text-sm">
          {savedMessage}
        </div>
      )}

      {/* 読み込みに失敗したときはフォームを出さない (空の入力欄から保存すると、保存されている値を消してしまう) */}
      {org && (
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label htmlFor="org-settings-name" className="block text-sm font-medium text-gray-700 mb-2">
                組織名
              </label>
              <input
                id="org-settings-name"
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
                maxLength={ORG_SETTINGS_NAME_MAX_LENGTH}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="org-settings-industry" className="block text-sm font-medium text-gray-700 mb-2">
                業種
              </label>
              <input
                id="org-settings-industry"
                type="text"
                value={formData.industry}
                onChange={(e) => setFormData({ ...formData, industry: e.target.value })}
                maxLength={ORG_INDUSTRY_MAX_LENGTH}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="例: IT"
              />
            </div>
            <div>
              <label htmlFor="org-settings-employee-count" className="block text-sm font-medium text-gray-700 mb-2">
                従業員数
              </label>
              <input
                id="org-settings-employee-count"
                type="number"
                value={formData.employeeCount}
                onChange={(e) => setFormData({ ...formData, employeeCount: e.target.value })}
                min={ORG_EMPLOYEE_COUNT_MIN}
                max={ORG_EMPLOYEE_COUNT_MAX}
                step={1}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="org-settings-contact-name" className="block text-sm font-medium text-gray-700 mb-2">
                担当者名
              </label>
              <input
                id="org-settings-contact-name"
                type="text"
                value={formData.contactName}
                onChange={(e) => setFormData({ ...formData, contactName: e.target.value })}
                maxLength={ORG_CONTACT_NAME_MAX_LENGTH}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="md:col-span-2">
              <label htmlFor="org-settings-contact-email" className="block text-sm font-medium text-gray-700 mb-2">
                連絡先メール
              </label>
              <input
                id="org-settings-contact-email"
                type="email"
                value={formData.contactEmail}
                onChange={(e) => setFormData({ ...formData, contactEmail: e.target.value })}
                maxLength={ORG_CONTACT_EMAIL_MAX_LENGTH}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "保存中..." : "設定を保存"}
          </button>
        </form>
      )}
    </div>
  );
}

