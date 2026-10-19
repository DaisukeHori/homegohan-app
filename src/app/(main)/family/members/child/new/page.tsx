'use client';

// src/app/(main)/family/members/child/new/page.tsx
// (設計書 03-ui-spec.md §8, 02-flow-spec.md §8)
// #1173 (設計書 cross/14 §6.5.6 の 9): 生年月日を必須にし (列 family_members.birth_date へ)、18 歳未満なら
// 保護者の同意 (親権者の確認・同意・署名の氏名) の枠を出す。同意は子供の追加と同じ API で記録される
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  PARENTAL_CONSENT_COPY,
  PARENTAL_CONSENT_DOCUMENT,
  PARENTAL_CONSENT_DOCUMENT_COPY,
  PARENTAL_CONSENT_DOCUMENT_PATH,
  SIGNED_NAME_MAX_LENGTH,
  requiresParentalConsent,
  todayLocal,
  validateBirthDate,
} from '@homegohan/shared';
import { createClient } from '@/lib/supabase/client';
import {
  MEMBERSHIP_ERROR_MESSAGES,
  MembershipErrorCode,
  membershipErrorMessageOfBody,
} from '@/lib/errors/membership-errors';
import { CHILD_DISPLAY_NAME_MAX_LENGTH } from '@/schemas/membership/family-member';

/** 子供の追加画面に出す同意書の要約の段落の数 (全文はリンク先の /legal/parental-consent) */
const CONSENT_SUMMARY_PARAGRAPH_COUNT = 2;

/** 失敗の本文 { error: { code } } の code (読めなければ undefined) */
function errorCodeOf(body: unknown): unknown {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  return error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
}

const GENDER_OPTIONS = [
  { value: '', label: '未設定' },
  { value: 'male', label: '男の子' },
  { value: 'female', label: '女の子' },
  { value: 'other', label: 'その他' },
];

export default function FamilyChildNewPage() {
  const router = useRouter();
  const supabase = createClient();

  const [familyId, setFamilyId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState('');
  const [guardianAttested, setGuardianAttested] = useState(false);
  const [agreedToConsent, setAgreedToConsent] = useState(false);
  const [signedName, setSignedName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);

  const today = todayLocal();
  const birthDateProblem = birthDate === '' ? null : validateBirthDate(birthDate, today);
  const birthDateValid = birthDate !== '' && birthDateProblem === null;
  const consentRequired = birthDateValid && requiresParentalConsent(birthDate, today);
  const consentComplete = guardianAttested && agreedToConsent && signedName.trim().length > 0;
  const canSubmit = displayName.trim() !== '' && birthDateValid && (!consentRequired || consentComplete);

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push('/login');
        return;
      }

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('family_id')
        .eq('id', user.id)
        .single();

      if (!profile?.family_id) {
        router.replace('/family/setup');
        return;
      }

      setFamilyId(profile.family_id);
    };

    init();
  }, [supabase, router]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!displayName.trim()) {
      setError('名前を入力してください');
      return;
    }
    if (!familyId) {
      setError('家族グループが見つかりません');
      return;
    }

    if (!canSubmit) return;
    setNeedsReload(false);

    // 生年月日は列 (body の birth_date) に入れる。child_profile には入れない
    const childProfile: Record<string, unknown> = {};
    if (gender) childProfile.gender = gender;

    setLoading(true);
    try {
      const res = await fetch('/api/family/members/child', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          family_id: familyId,
          display_name: displayName.trim(),
          child_profile: childProfile,
          birth_date: birthDate,
          ...(consentRequired
            ? { consent: { version: PARENTAL_CONSENT_DOCUMENT.version, signed_name: signedName, guardian_attested: true } }
            : {}),
        }),
      });

      const json: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const code = errorCodeOf(json);
        if (code === MembershipErrorCode.MEMBER_LIMIT_EXCEEDED) {
          setError('メンバー数の上限に達しています');
        } else {
          // 画面を開いたまま同意書の版が上がった (409) ときは、読み込み直して新しい版を読んでもらう
          setNeedsReload(code === MembershipErrorCode.PARENTAL_CONSENT_VERSION_MISMATCH);
          setError(membershipErrorMessageOfBody(json));
        }
        return;
      }

      router.push('/family/members');
    } catch (err) {
      setError('通信エラーが発生しました');
      console.error('[family/members/child/new] error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* ヘッダー */}
      <div className="bg-white p-6 pb-4 border-b border-gray-100 sticky top-0 z-20">
        <button
          onClick={() => router.back()}
          className="text-sm text-gray-400 mb-2 flex items-center gap-1"
        >
          ← 戻る
        </button>
        <h1 className="text-2xl font-bold text-gray-900">子供を追加</h1>
        <p className="text-xs text-gray-400 mt-1">アカウントを作成せずに家族に追加できます</p>
      </div>

      <div className="p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* 名前 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              名前 (家族での呼称)
              <span className="text-red-500 ml-1">*</span>
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="例: 太郎"
              maxLength={CHILD_DISPLAY_NAME_MAX_LENGTH}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
              disabled={loading}
            />
            <p className="text-xs text-gray-400 mt-1">
              {displayName.length}/{CHILD_DISPLAY_NAME_MAX_LENGTH} 文字
            </p>
          </div>

          {/* 生年月日 */}
          <div>
            <label htmlFor="child-birth-date" className="block text-sm font-medium text-gray-700 mb-2">
              生年月日
              <span className="text-red-500 ml-1">*</span>
            </label>
            <input
              id="child-birth-date"
              type="date"
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value)}
              required
              aria-required="true"
              aria-invalid={birthDateProblem !== null}
              max={today}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
              disabled={loading}
            />
            {birthDateProblem !== null && (
              <p role="alert" className="text-xs text-red-600 mt-1">
                {MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.CHILD_BIRTH_DATE_INVALID]}
              </p>
            )}
          </div>

          {/* 保護者の同意 (18 歳未満のときだけ) */}
          {consentRequired && (
            <section className="space-y-3 rounded-2xl border border-orange-200 bg-orange-50 p-4" data-testid="parental-consent-section">
              <h2 className="font-bold text-gray-900">{PARENTAL_CONSENT_COPY.heading}</h2>
              <p className="text-sm text-gray-700">{PARENTAL_CONSENT_COPY.intro}</p>
              <div className="space-y-2 rounded-xl bg-white p-3 text-xs leading-relaxed text-gray-600">
                {PARENTAL_CONSENT_DOCUMENT_COPY.paragraphs.slice(0, CONSENT_SUMMARY_PARAGRAPH_COUNT).map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
              <Link
                href={PARENTAL_CONSENT_DOCUMENT_PATH}
                className="inline-block text-sm font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800"
              >
                {PARENTAL_CONSENT_COPY.readFullTextLabel}
              </Link>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={guardianAttested}
                  onChange={(e) => setGuardianAttested(e.target.checked)}
                  required
                  aria-required="true"
                  disabled={loading}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-[#FF8A65]"
                />
                <span className="text-sm text-gray-800">{PARENTAL_CONSENT_COPY.guardianAttestLabel}</span>
              </label>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={agreedToConsent}
                  onChange={(e) => setAgreedToConsent(e.target.checked)}
                  required
                  aria-required="true"
                  disabled={loading}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-[#FF8A65]"
                />
                <span className="text-sm text-gray-800">{PARENTAL_CONSENT_COPY.agreeLabel}</span>
              </label>
              <div>
                <label htmlFor="parental-consent-signed-name" className="block text-sm font-medium text-gray-700 mb-2">
                  {PARENTAL_CONSENT_COPY.signedNameLabel}
                </label>
                <input
                  id="parental-consent-signed-name"
                  type="text"
                  value={signedName}
                  onChange={(e) => setSignedName(e.target.value)}
                  placeholder={PARENTAL_CONSENT_COPY.signedNamePlaceholder}
                  maxLength={SIGNED_NAME_MAX_LENGTH}
                  required
                  aria-required="true"
                  disabled={loading}
                  className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
                />
              </div>
            </section>
          )}
          {birthDateValid && !consentRequired && (
            <p className="text-xs text-gray-500" data-testid="parental-consent-not-required">
              {PARENTAL_CONSENT_COPY.notRequiredNote}
            </p>
          )}

          {/* 性別 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              性別 (任意)
            </label>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
              disabled={loading}
            >
              {GENDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* 注意書き */}
          <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4">
            <p className="text-sm text-blue-700">
              ※ 子供本人のアカウントは作成しません。
              登録するのは、名前・生年月日・性別だけです。
              13歳以上なら、後でご本人のアカウントとつなぐこともできます (ご本人の承認が必要です)。
            </p>
          </div>

          {/* エラー */}
          {error && (
            <div role="alert" className="space-y-2 rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">
              <p>{error}</p>
              {needsReload && (
                <button type="button" onClick={() => window.location.reload()} className="font-bold underline underline-offset-2">
                  画面を読み込み直す
                </button>
              )}
            </div>
          )}

          {/* 送信ボタン */}
          <button
            type="submit"
            disabled={loading || !canSubmit}
            className="w-full rounded-full bg-green-500 py-4 text-white font-bold text-base hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? '追加中…' : '追加する'}
          </button>
        </form>
      </div>
    </div>
  );
}
