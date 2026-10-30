'use client';

// src/app/(main)/family/members/child/new/page.tsx
// (設計書 03-ui-spec.md §8, 02-flow-spec.md §8)
// #1173 (設計書 cross/14 §6.5.6 の 9): 生年月日を必須にし (列 family_members.birth_date へ)、18 歳未満なら
// 保護者の同意 (親権者の確認・同意・署名の氏名) の枠を出す。同意は子供の追加と同じ API で記録される
import { useState, useEffect, useCallback } from 'react';
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
import { loginPathWithNext, readSignedInUser } from '@/lib/auth/signed-in-user';
import {
  MEMBERSHIP_ERROR_MESSAGES,
  MembershipErrorCode,
  membershipErrorMessageOfBody,
} from '@/lib/errors/membership-errors';
import { CHILD_DISPLAY_NAME_MAX_LENGTH } from '@/schemas/membership/family-member';
import { MEMBERSHIP_STATE_UNCONFIRMED_NOTE } from '@/lib/membership/leave-state';

/** 追加の通信そのものが失敗した (fetch が reject した) ときの文 */
const NETWORK_FAILURE_MESSAGE = '通信エラーが発生しました';

/**
 * 自分のプロフィールを読み込めなかった・問い合わせが例外を投げたときの文 (#2073 S3)。家族に入っていない (家族の作成の画面へ移す) と
 * 見分けるために出す (家族のメンバーの画面の FAMILY_MEMBERS_LOAD_ERROR と同じ扱い)。失敗の理由 (英語の内部の文) は画面に出さない
 */
const CHILD_NEW_LOAD_ERROR = '家族の情報を読み込めませんでした。しばらくしてから、もう一度お試しください。';

/** この画面のパス (ログインのあとに戻る先) */
const CHILD_NEW_PATH = '/family/members/child/new';

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
  // 読み込めなかったときの文。あるあいだはフォームの代わりにこの文と「再試行」を出す (#2073 S3。以前は自分のプロフィールを読めないと
  // 家族に入っていないとして家族の作成の画面へ移し、問い合わせが例外を投げると未処理の reject になっていた)
  const [loadError, setLoadError] = useState<string | null>(null);

  const today = todayLocal();
  const birthDateProblem = birthDate === '' ? null : validateBirthDate(birthDate, today);
  const birthDateValid = birthDate !== '' && birthDateProblem === null;
  const consentRequired = birthDateValid && requiresParentalConsent(birthDate, today);
  const consentComplete = guardianAttested && agreedToConsent && signedName.trim().length > 0;
  const canSubmit = displayName.trim() !== '' && birthDateValid && (!consentRequired || consentComplete);

  // 自分の家族を読む。画面を開いたときと「再試行」で呼ぶ
  const loadFamily = useCallback(async () => {
    try {
      // getUser は通信の失敗を投げずに { user: null, error } で返す。ログインの画面へ移すのはログインしていないときだけにし、
      // 確かめられなかったときは読み込みの失敗と「再試行」を出す (#2093 W4。以前は通信が切れているだけでもログインの画面へ移していた)。
      // ログインのあとにこの画面へ戻れるよう next を付ける
      const signedIn = await readSignedInUser(supabase);
      if (signedIn.kind === 'load-failed') {
        setLoadError(CHILD_NEW_LOAD_ERROR);
        return;
      }
      if (signedIn.kind === 'signed-out') {
        router.push(loginPathWithNext(CHILD_NEW_PATH));
        return;
      }
      const { user } = signedIn;

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('family_id')
        .eq('id', user.id)
        .single();

      if (profileError) {
        // 自分のプロフィールを読めなかった (家族に入っていないのとは別。家族の作成の画面へ送らない)
        setLoadError(CHILD_NEW_LOAD_ERROR);
        return;
      }
      if (!profile?.family_id) {
        router.replace('/family/setup');
        return;
      }

      setFamilyId(profile.family_id);
      setLoadError(null);
    } catch (loadFailure) {
      console.error('[family/members/child/new] load error:', loadFailure);
      setLoadError(CHILD_NEW_LOAD_ERROR);
    }
  }, [supabase, router]);

  useEffect(() => {
    void loadFamily();
  }, [loadFamily]);

  /**
   * 家族の中の、同じ名前・同じ生年月日のアカウント無しの子供の行 (active) の ID を読む。
   * 追加の通信が失敗したときに、送る前と比べて行が増えたか (サーバーが追加を済ませていたか) を確かめるために使う (#2073 S2)。
   * 読めなければ null (例外は投げない)
   */
  const readSameChildIds = async (targetFamilyId: string, name: string, birth: string): Promise<string[] | null> => {
    try {
      const { data, error: readError } = await supabase
        .from('family_members')
        .select('id')
        .eq('family_id', targetFamilyId)
        .eq('role', 'child')
        .eq('status', 'active')
        .eq('display_name', name)
        .eq('birth_date', birth);
      if (readError || !data) return null;
      return data.map((row) => row.id);
    } catch (readFailure) {
      console.error('[family/members/child/new] failed to read children:', readFailure);
      return null;
    }
  };

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

    const childName = displayName.trim();
    setLoading(true);
    // 送る前の、同じ子供の行。通信が失敗したときに、追加できていたかを見分けるために使う (#2073 S2)
    const childIdsBefore = await readSameChildIds(familyId, childName, birthDate);
    try {
      const res = await fetch('/api/family/members/child', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          family_id: familyId,
          display_name: childName,
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
      console.error('[family/members/child/new] error:', err);
      // サーバーが追加を済ませてから応答が切れたこともあるので、同じ子供の行を読み直して確かめる (#2073 S2。
      // 以前は確かめずに通信エラーの文を出し、フォームが残るので、もう一度送ると同じ子供が 2 人になっていた (API に重複の守りは無い))。
      // 読み直しの応答を待つあいだも「追加する」を止めたままにする (loading を戻さない)
      const childIdsAfter = await readSameChildIds(familyId, childName, birthDate);
      if (childIdsAfter === null) {
        // 確かめられなかった
        setError(`${NETWORK_FAILURE_MESSAGE} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})`);
        return;
      }
      if (childIdsBefore === null) {
        // 送る前を読めなかった: 同じ子供の行があっても、今回の追加か前からの行か見分けられない
        setError(
          childIdsAfter.length > 0
            ? `${NETWORK_FAILURE_MESSAGE} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})`
            : NETWORK_FAILURE_MESSAGE,
        );
        return;
      }
      if (childIdsAfter.some((id) => !childIdsBefore.includes(id))) {
        // 追加できている: 成功のときと同じ遷移
        router.push('/family/members');
        return;
      }
      // 追加できていない: これまでどおり通信エラーの文 (フォームはそのまま。送り直してよい)
      setError(NETWORK_FAILURE_MESSAGE);
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
        {loadError ? (
          <div
            role="alert"
            data-testid="family-child-new-load-error"
            className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm"
          >
            <span>{loadError}</span>
            <button
              type="button"
              onClick={() => void loadFamily()}
              className="shrink-0 px-3 py-1.5 bg-white border border-red-300 rounded-lg text-red-700 hover:bg-red-100 transition-colors"
            >
              再試行
            </button>
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
}
