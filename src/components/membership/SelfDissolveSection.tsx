'use client';

// #1917 家族グループ / 組織を解散する区画 (docs/design/family/11-self-dissolve.md §15.2)。
// 使う画面: メンバーシップ設定 (§15.1)・退会と書き出しの枠 AccountSelfServicePanel (§15.4。凍結中の画面 /frozen/account と同意の前の画面 /legal-consent/account)。
// 親から id と名前を受け取り、解散の API を呼ぶだけ (設定画面の状態や Supabase の読み取りに依存しない)。
import { useState } from 'react';
import type { MembershipScope } from '@/lib/emails/membership/scope-label';
import {
  SELF_DISSOLVE_CONFIRM_KEYWORD,
  SELF_DISSOLVE_COPY,
  dissolveOwnScope,
  selfDissolveEffects,
  type SelfDissolveSurface,
} from '@/lib/membership/self-dissolve';

export interface SelfDissolveSectionProps {
  scope: MembershipScope;
  scopeId: string;
  /** 家族グループ名 / 組織名 (見出しに「「山田家」を解散する」の形で出す) */
  scopeName: string;
  /**
   * 区画を出す画面 (メンバーシップ設定 / 凍結中の画面 / 同意の前の画面)。家族プランの解約の案内は、その画面の利用者が開ける画面を名指す
   * (FAMILY_PLAN_CONTINUES_AFTER_DISSOLVE。凍結中・同意の前の人は「プランとお支払い」(/account/billing) を開けない)
   */
  surface: SelfDissolveSurface;
  /** 解散が済んだ (200) あと。親が所属を読み直す・次の案内を出す */
  onDissolved: (dissolvedAt: string) => void;
  /** 「キャンセル」。親が区画を閉じる */
  onCancel?: () => void;
  /** ログインが切れていた (401)。親がログインの画面へ移す */
  onUnauthorized?: () => void;
}

export function SelfDissolveSection({ scope, scopeId, scopeName, surface, onDissolved, onCancel, onUnauthorized }: SelfDissolveSectionProps) {
  const copy = SELF_DISSOLVE_COPY[scope];
  const effects = selfDissolveEffects(scope, surface);
  const [keyword, setKeyword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = keyword === SELF_DISSOLVE_CONFIRM_KEYWORD && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const result = await dissolveOwnScope(scope, scopeId);
    switch (result.kind) {
      case 'dissolved':
        onDissolved(result.dissolvedAt);
        return; // 親が区画を閉じる (unmount)。state は戻さない
      case 'unauthorized':
        onUnauthorized?.();
        break;
      case 'failed':
        setError(result.message);
        break;
    }
    setSubmitting(false);
  };

  return (
    <section aria-labelledby={`self-dissolve-${scope}-title`} className="rounded-2xl border border-red-100 bg-white p-5 space-y-3">
      <h3 id={`self-dissolve-${scope}-title`} className="font-bold text-gray-800">
        「{scopeName}」を解散する
      </h3>
      <ul className="list-disc pl-5 text-sm text-gray-600 space-y-1">
        {effects.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <label className="block text-sm text-gray-700">
        {copy.keywordPrompt}
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          disabled={submitting}
          autoComplete="off"
          className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2"
          data-testid={`self-dissolve-${scope}-keyword`}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={submitting} className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm text-gray-600">
            キャンセル
          </button>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          data-testid={`self-dissolve-${scope}-submit`}
          className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {submitting ? copy.submitting : copy.button}
        </button>
      </div>
    </section>
  );
}
