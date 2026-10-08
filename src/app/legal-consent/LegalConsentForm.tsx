'use client';

// src/app/legal-consent/LegalConsentForm.tsx
// #1174: 利用規約・プライバシーポリシーへの同意画面 (改定時の再同意ゲート / 新規登録後の初回の同意)
//
// - 利用規約・プライバシーポリシーそれぞれに必須のチェックボックス (どちらかが未チェックの間は「同意して続ける」を押せない)
// - 「同意して続ける」: POST /api/legal/accept で同意を記録し、元の画面 (next) へ戻る。記録は DB 関数が本人の行だけに行う
// - 「同意しない」: ログアウトして、ご利用いただけないこと・保存データの削除の依頼先 (お問い合わせ) を案内する
//
// 文面へのリンクは同じタブで開く。アプリ (WebView) では target="_blank" のリンクが開けないことがあり、
// 同意の根拠になる文面を読めなくなるのを避けるため。読んだあとはブラウザの「戻る」で、この画面に戻れる。
import { useState } from 'react';
import Link from 'next/link';
import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_LABELS,
  LEGAL_DOCUMENT_PATHS,
  LEGAL_DOCUMENT_TYPES,
  formatLegalEffectiveDate,
  type LegalDocumentType,
} from '@homegohan/shared';
import { createClient } from '@/lib/supabase/client';
import { broadcastSignOut, clearUserScopedLocalStorage } from '@/lib/user-storage';
import { LEGAL_CONSENT_PATH } from '@/lib/legal-consent';

interface LegalConsentFormProps {
  /** 同意したあとに戻る先 (検証済みの同一オリジンの相対パス) */
  next: string;
  /** すでにいずれかの版に同意していた人か (改定による再同意か、初回の同意か) */
  isReconsent: boolean;
  /** いま有効な版に同意していない文書 */
  outdated: LegalDocumentType[];
}

type Phase = 'idle' | 'submitting' | 'declining' | 'declined';

const GENERIC_ERROR = '同意の記録に失敗しました。時間をおいて、もう一度お試しください。';

export default function LegalConsentForm({ next, isReconsent, outdated }: LegalConsentFormProps) {
  const [agreed, setAgreed] = useState<Record<LegalDocumentType, boolean>>({
    terms_of_service: false,
    privacy_policy: false,
  });
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);

  const allAgreed = LEGAL_DOCUMENT_TYPES.every((type) => agreed[type]);
  const busy = phase === 'submitting' || phase === 'declining';

  const handleAccept = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!allAgreed || busy) return;
    setError(null);
    setNeedsReload(false);
    setPhase('submitting');

    try {
      const res = await fetch('/api/legal/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          terms_version: LEGAL_DOCUMENTS.terms_of_service.version,
          privacy_version: LEGAL_DOCUMENTS.privacy_policy.version,
        }),
      });

      if (res.ok) {
        // 画面遷移ではなく読み込み直しで戻る: middleware の判定とサーバー側の画面を、同意後の状態で最初から作らせる
        window.location.assign(next);
        return;
      }
      if (res.status === 401) {
        window.location.assign(
          `/login?next=${encodeURIComponent(`${LEGAL_CONSENT_PATH}?next=${encodeURIComponent(next)}`)}`,
        );
        return;
      }
      if (res.status === 409) {
        // 画面を開いたまま規約が改定された。読み込み直して、いまの版を読んでもらう
        setNeedsReload(true);
        setError('利用規約・プライバシーポリシーが更新されました。画面を読み込み直して、内容をご確認ください。');
      } else {
        setError(GENERIC_ERROR);
      }
    } catch {
      setError('通信に失敗しました。通信状態をご確認のうえ、もう一度お試しください。');
    }
    setPhase('idle');
  };

  const handleDecline = async () => {
    if (busy) return;
    setError(null);
    setPhase('declining');
    try {
      // CLAUDE.md の規約: サインアウトでは、Supabase の signOut より先に利用者単位の localStorage を消す
      clearUserScopedLocalStorage();
      // supabase-js の signOut は、通信に失敗しても例外を投げず { error } を返し、その間はセッションが残る。
      // 「ログアウトしました」と案内してしまわないよう、返ってきた error も失敗として扱う
      const { error: signOutError } = await createClient().auth.signOut();
      if (signOutError) throw signOutError;
      broadcastSignOut();
      setPhase('declined');
    } catch {
      setError('ログアウトに失敗しました。通信状態をご確認のうえ、もう一度お試しください。');
      setPhase('idle');
    }
  };

  if (phase === 'declined') {
    return (
      <div className="space-y-6" data-testid="legal-consent-declined">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">ご利用を終了しました</h1>
          <p className="text-sm leading-relaxed text-gray-600">
            利用規約・プライバシーポリシーに同意いただけない場合、ほめゴハンはご利用いただけません。ログアウトしました。
          </p>
        </div>

        <section className="space-y-2 rounded-2xl border border-gray-200 bg-gray-50 p-4">
          <h2 className="font-bold text-gray-900">保存されているデータの削除について</h2>
          <p className="text-sm leading-relaxed text-gray-600">
            これまでにご登録いただいた情報（食事の記録・健康に関する情報など）の削除をご希望の場合は、お問い合わせフォームからご連絡ください。
            ご本人であることを確認のうえ、アカウントと保存されているデータを削除します。
          </p>
          <Link
            href="/contact"
            className="inline-block font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800"
          >
            お問い合わせフォームへ
          </Link>
        </section>

        <p className="text-sm text-gray-500">
          内容をご確認のうえ、ご利用を再開される場合は、もう一度
          <Link href="/login" className="font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800">
            ログイン
          </Link>
          してください。
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleAccept} className="space-y-6" noValidate>
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">利用規約・プライバシーポリシーへの同意</h1>
        <p className="text-sm leading-relaxed text-gray-600">
          {isReconsent
            ? '利用規約・プライバシーポリシーが改定されました。引き続きご利用いただくには、内容をご確認のうえ、同意をお願いします。'
            : 'ほめゴハンをご利用いただくには、利用規約とプライバシーポリシーへの同意が必要です。内容をご確認ください。'}
        </p>
      </div>

      <ul className="space-y-3">
        {LEGAL_DOCUMENT_TYPES.map((type) => {
          const { version, effectiveDate } = LEGAL_DOCUMENTS[type];
          const label = LEGAL_DOCUMENT_LABELS[type];
          const revised = isReconsent && outdated.includes(type);
          return (
            <li key={type} className="space-y-2 rounded-2xl border border-gray-200 p-4" data-testid={`legal-doc-${type}`}>
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-bold text-gray-900">{label}</h2>
                {revised && (
                  <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-bold text-orange-700">改定あり</span>
                )}
              </div>
              <p className="text-xs text-gray-500">
                版: {version} ／ 施行日: {formatLegalEffectiveDate(effectiveDate)}
              </p>
              <Link
                href={LEGAL_DOCUMENT_PATHS[type]}
                className="inline-block text-sm font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800"
              >
                {label}の全文を読む
              </Link>
              <label className="flex cursor-pointer items-start gap-3 pt-1">
                <input
                  type="checkbox"
                  name={`agree-${type}`}
                  checked={agreed[type]}
                  onChange={(e) => setAgreed((current) => ({ ...current, [type]: e.target.checked }))}
                  disabled={busy}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-[#FF8A65]"
                />
                <span className="text-sm text-gray-800">{label}の内容を確認し、同意します</span>
              </label>
            </li>
          );
        })}
      </ul>

      {error && (
        <div role="alert" className="space-y-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-sm font-medium text-red-600">
          <p>{error}</p>
          {needsReload && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="font-bold underline underline-offset-2"
            >
              画面を読み込み直す
            </button>
          )}
        </div>
      )}

      <div className="space-y-3">
        <button
          type="submit"
          disabled={!allAgreed || busy}
          className="w-full rounded-full bg-[#FF8A65] py-4 font-bold text-white shadow-lg transition-all duration-300 hover:bg-[#FF7043] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
        >
          {phase === 'submitting' ? '記録しています...' : '同意して続ける'}
        </button>
        <button
          type="button"
          onClick={handleDecline}
          disabled={busy}
          className="w-full rounded-full py-3 text-sm font-bold text-gray-500 underline underline-offset-4 hover:text-gray-700 disabled:opacity-50"
        >
          {phase === 'declining' ? 'ログアウトしています...' : '同意しない（ログアウトする）'}
        </button>
      </div>
    </form>
  );
}
