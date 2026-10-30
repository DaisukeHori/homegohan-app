'use client';

// src/app/(main)/family/members/[id]/page.tsx
// (設計書 03-ui-spec.md §3.2, 02-flow-spec.md §13)
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  PARENTAL_CONSENT_COPY,
  PARENTAL_CONSENT_DOCUMENT_PATH,
  calculateAgeYears,
  requiresParentalConsent,
  todayLocal,
} from '@homegohan/shared';
import { createClient } from '@/lib/supabase/client';
import { readSignedInUser } from '@/lib/auth/signed-in-user';
import { applyFamilyMemberNames, fetchFamilyMemberNames } from '@/lib/membership/family-member-names';
import { membershipErrorMessageOfBody } from '@/lib/errors/membership-errors';
import { familyRoleLabel } from '@/lib/membership/role-labels';
import { withMembershipStateNote, type MembershipStateAfterNetworkFailure } from '@/lib/membership/leave-state';
import {
  readOwnShareSettingsAfterNetworkFailure,
  withShareSettingsUnconfirmedNote,
  type FamilyShareSettings,
} from '@/lib/membership/share-settings-state';

/** 除名・共有設定の通信そのものが失敗した (fetch が reject した) ときの文 */
const NETWORK_FAILURE_MESSAGE = '通信エラーが発生しました';

/**
 * 自分のプロフィール・家族の中の自分の役割を読み込めなかったときの文 (#2073 S3)。家族に入っていない (家族の作成の画面へ移す) ・
 * 権限が無い (操作を出さない) と見分けるために出す (家族のメンバーの画面の FAMILY_MEMBERS_LOAD_ERROR と同じ扱い)。
 * 失敗の理由 (英語の内部の文) は画面に出さない
 */
const MEMBER_DETAIL_LOAD_ERROR = 'メンバーの情報を読み込めませんでした。しばらくしてから、もう一度お試しください。';

/**
 * 開いたメンバーの行が無い (または RLS で見えない・脱退・除名した行) ときの文 (#2093 W10。以前は「メンバー情報の取得に失敗しました」で、
 * 読み込みの失敗 (MEMBER_DETAIL_LOAD_ERROR と「再試行」) と読め、開き直しを繰り返しかねなかった)。一覧へ戻る導線と一緒に出す
 */
const MEMBER_NOT_FOUND_MESSAGE = 'このメンバーは見つかりません (家族から外れた可能性があります)。一覧に戻って確かめてください';

/** 家族のメンバーの一覧のパス (メンバーが見つからないときに戻る先) */
const FAMILY_MEMBERS_PATH = '/family/members';

interface FamilyMember {
  id: string;
  role: 'representative' | 'adult' | 'child';
  display_name: string | null;
  user_id: string | null;
  child_profile: Record<string, unknown> | null;
  /** 子供の生年月日 (#1173。アカウント無しの子供の行は必須) */
  birth_date: string | null;
  share_meals: boolean;
  share_health: boolean;
  share_menu: boolean;
  joined_at: string;
}

/** 子供の保護者の同意の記録 (#1173。RLS で読めるのはその家族の大人・署名した本人・運営) */
interface ParentalConsentRecord {
  id: string;
  signed_name: string;
  consent_version: string;
  signed_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

/**
 * .single() で行が 0 件 (または RLS で見えない) ときの PostgREST の失敗のコード。
 * 行が無いのは「読み込めなかった」ではないので、これだけは読み込みの失敗と分ける
 */
const POSTGREST_NO_ROWS_CODE = 'PGRST116';

/** 問い合わせの失敗が「行が無い」ではない (= 読み込めなかった) か */
function isLoadFailure(error: { code?: string } | null): boolean {
  return error !== null && error.code !== POSTGREST_NO_ROWS_CODE;
}

/** 'YYYY-MM-DD' → 'YYYY年M月D日' (暦日の文字列をそのまま読む。時差でずらさない) */
function formatBirthDate(birthDate: string): string {
  const [year, month, day] = birthDate.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

/** 日時 (ISO) を日本時間で出す */
function formatJstDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

export default function FamilyMemberDetailPage() {
  // パスの値は useParams で読む。props の params は Next 15 から Promise で、Next 14 では use(params) が例外になった (#1275)。
  // useParams はどちらでも同じに使えるので、こちらにそろえている (#1444)。
  const { id: memberId } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [member, setMember] = useState<FamilyMember | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentRole, setCurrentRole] = useState<string | null>(null);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [shareMeals, setShareMeals] = useState(true);
  const [shareHealth, setShareHealth] = useState(false);
  const [shareMenu, setShareMenu] = useState(true);
  const [savingShare, setSavingShare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [consent, setConsent] = useState<ParentalConsentRecord | null>(null);
  // 読み込めなかったときの文。あるあいだは画面の代わりにこの文と「再試行」を出す (#2073 S3。以前は自分のプロフィールを読めないと
  // 家族に入っていないとして家族の作成の画面へ移し、問い合わせが例外を投げると読み込み中の表示のまま止まっていた)
  const [loadError, setLoadError] = useState<string | null>(null);

  // メンバーと自分の役割を読む。画面を開いたときと「再試行」で呼ぶ
  const loadPage = useCallback(async () => {
    setLoading(true);
    // 別の画面へ移るときは、移るまで読み込み中の表示のままにする (これまでどおり)
    let redirecting = false;
    try {
      // getUser は通信の失敗を投げずに { user: null, error } で返す。ログインの画面へ移すのはログインしていないときだけにし、
      // 確かめられなかったときは読み込みの失敗と「再試行」を出す (#2086 V3。以前は通信が切れているだけでもログインの画面へ移していた)。
      // ログインのあとにこの画面へ戻れるよう next を付ける
      const signedIn = await readSignedInUser(supabase);
      if (signedIn.kind === 'load-failed') {
        setLoadError(MEMBER_DETAIL_LOAD_ERROR);
        return;
      }
      if (signedIn.kind === 'signed-out') {
        redirecting = true;
        router.push(`/login?next=${encodeURIComponent(`/family/members/${memberId}`)}`);
        return;
      }
      const { user } = signedIn;
      setCurrentUserId(user.id);

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('family_id')
        .eq('id', user.id)
        .single();

      if (profileError) {
        // 自分のプロフィールを読めなかった (家族に入っていないのとは別。家族の作成の画面へ送らない)
        setLoadError(MEMBER_DETAIL_LOAD_ERROR);
        return;
      }
      if (!profile?.family_id) {
        redirecting = true;
        router.replace('/family/setup');
        return;
      }
      setFamilyId(profile.family_id);

      const { data: memberData, error: memberError } = await supabase
        .from('family_members')
        .select('id, role, display_name, user_id, child_profile, birth_date, share_meals, share_health, share_menu, joined_at')
        .eq('id', memberId)
        .eq('family_id', profile.family_id)
        // 今のメンバーの行だけを開く (#2086 V10。脱退・除名した行は消えずに status が left / removed で残るので、
        // 絞らないと古い URL から脱退済み・除名済みの人を今のメンバーのように見せていた。無ければ「見つかりません」。#2093 W10)
        .eq('status', 'active')
        .single();

      if (isLoadFailure(memberError)) {
        // 読み込めなかった (行が無いのとは別。「再試行」を出す。#2080 U3)
        setLoadError(MEMBER_DETAIL_LOAD_ERROR);
        return;
      }
      if (!memberData) {
        // 行が無い (PGRST116)・RLS で見えない・今のメンバーでない (脱退・除名した行。#2086 V10)
        setError(MEMBER_NOT_FOUND_MESSAGE);
        setLoadError(null);
        return;
      }

      // 画面に出す名前 (display_name が無ければ本人のプロフィールの今の名前) は API で決める (#1584)
      const names = await fetchFamilyMemberNames();
      const [namedMember] = applyFamilyMemberNames([memberData as FamilyMember], names);
      setMember(namedMember);
      setShareMeals(memberData.share_meals);
      setShareHealth(memberData.share_health);
      setShareMenu(memberData.share_menu);

      // #1173: 子供なら保護者の同意の記録 (最新の 1 行) を読む。読めなければカードを出さない
      if (memberData.role === 'child') {
        const { data: consentData } = await supabase
          .from('parental_consents')
          .select('id, signed_name, consent_version, signed_at, revoked_at, revoked_reason')
          .eq('family_member_id', memberId)
          .order('signed_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        setConsent((consentData as ParentalConsentRecord | null) ?? null);
      }

      // 現在ユーザーのロールを、自分の active な行から取得する (#2080 U2。脱退・除名した行は消えずに status が left / removed で残り、
      // 招待で同じ家族に戻ると自分の行が 2 本になる。以前は status で絞らず .single() で読んでいたので、2 本の人は失敗して権限なしに見えていた。
      // active な行は 1 人 1 行まで (部分 UNIQUE uniq_family_members_user)。
      // 行が無いときは権限なし。読み込めなかったときは、権限なしと見せない)
      const { data: myMember, error: myMemberError } = await supabase
        .from('family_members')
        .select('role')
        .eq('family_id', profile.family_id)
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle();
      if (myMemberError) {
        setLoadError(MEMBER_DETAIL_LOAD_ERROR);
        return;
      }

      setCurrentRole(myMember?.role ?? null);
      setError(null);
      setLoadError(null);
    } catch (loadFailure) {
      // 問い合わせが例外を投げた (以前は try / catch が無く、読み込み中の表示のまま止まり、未処理の reject になっていた)
      console.error('[family/members/[id]] load error:', loadFailure);
      setLoadError(MEMBER_DETAIL_LOAD_ERROR);
    } finally {
      if (!redirecting) setLoading(false);
    }
  }, [supabase, router, memberId]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const isSelf = member?.user_id === currentUserId;
  const isOwnerOrAdmin = currentRole === 'representative' || currentRole === 'adult';

  /** 画面の 3 つの共有の設定をまとめて置き換える */
  const showShareSettings = (settings: FamilyShareSettings) => {
    setShareMeals(settings.share_meals);
    setShareHealth(settings.share_health);
    setShareMenu(settings.share_menu);
  };

  const handleShareUpdate = async (field: keyof FamilyShareSettings, value: boolean) => {
    const previous: FamilyShareSettings = { share_meals: shareMeals, share_health: shareHealth, share_menu: shareMenu };
    showShareSettings({ ...previous, [field]: value });

    setSavingShare(true);
    try {
      const res = await fetch('/api/family/members/me/share', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        // 応答が届いたうえでの失敗は、更新されていないので元に戻す (これまでどおり)
        showShareSettings(previous);
        alert('共有設定の更新に失敗しました');
      }
    } catch {
      // サーバーが更新を済ませてから応答が切れたこともあるので、元に戻さず、サーバーの今の値を読み直して出す (#2073 S2。
      // 以前は元に戻していたので、例えば健康の記録の共有はサーバーで有効なのに、画面は無効と見せていた)。
      // 読み直しの応答を待つあいだも切り替えを止めたままにする (savingShare を戻さない)
      const reread = await readOwnShareSettingsAfterNetworkFailure(supabase);
      if (!reread.ok) {
        // 確かめられなかった: 最後に分かっているサーバーの値 (切り替える前) に戻し、確かめられなかった旨を添える
        showShareSettings(previous);
        alert(withShareSettingsUnconfirmedNote(NETWORK_FAILURE_MESSAGE));
      } else {
        showShareSettings(reread.settings);
        // 更新できていれば、成功のときと同じ (文を出さない)
        if (reread.settings[field] !== value) alert(NETWORK_FAILURE_MESSAGE);
      }
    } finally {
      setSavingShare(false);
    }
  };

  const handleRemove = async () => {
    if (!familyId || !member) return;
    if (!window.confirm(`${member.display_name ?? 'このメンバー'} を家族グループから外しますか？`)) return;

    setActionLoading(true);
    try {
      const res = await fetch(`/api/family/members/${member.id}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ family_id: familyId }),
      });
      if (!res.ok) {
        // 理由は本文の code から引く (本文の message は操作ごとの固定の文で理由が読めない。#1576)
        const json: unknown = await res.json().catch(() => null);
        alert(`除名に失敗しました: ${membershipErrorMessageOfBody(json)}`);
        return;
      }
      router.replace(FAMILY_MEMBERS_PATH);
    } catch {
      // サーバーが除名を済ませてから応答が切れたこともあるので、そのメンバーの行を読み直して確かめる (#2064。
      // 家族のメンバーの画面の除名と同じ型。確かめないと、除名したメンバーの詳細が残り、もう一度押すと失敗の文が出ていた)。
      // 読み直しの応答を待つあいだもボタンを止めたままにする (actionLoading を戻さない)
      const state = await readMemberStateAfterNetworkFailure(member.id, familyId);
      if (state === 'left') {
        // 家族から外れている: 成功のときと同じ遷移
        router.replace(FAMILY_MEMBERS_PATH);
        return;
      }
      // 外れていない: これまでどおり通信エラーの文。確かめられなかったときは「状態を確かめられませんでした」を添える
      alert(withMembershipStateNote(NETWORK_FAILURE_MESSAGE, state));
    } finally {
      setActionLoading(false);
    }
  };

  /**
   * 除名の通信が失敗したあとに、そのメンバーが今も家族にいるか (status が active の行があるか) を読み直す。
   * remove_family_member は family_members.status を 'removed' にするので、active の行が無ければ外れている。
   * 例外は投げない (問い合わせの失敗・例外は unknown)
   */
  const readMemberStateAfterNetworkFailure = async (
    targetMemberId: string,
    targetFamilyId: string,
  ): Promise<MembershipStateAfterNetworkFailure> => {
    try {
      const { data: activeRow, error: activeRowError } = await supabase
        .from('family_members')
        .select('id')
        .eq('id', targetMemberId)
        .eq('family_id', targetFamilyId)
        .eq('status', 'active')
        .maybeSingle();
      if (activeRowError) return 'unknown';
      return activeRow ? 'still-member' : 'left';
    } catch (readFailure) {
      console.error('[family/members/[id]] failed to confirm removal after network failure:', readFailure);
      return 'unknown';
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-400 text-sm">読み込み中…</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <div
          role="alert"
          data-testid="family-member-detail-load-error"
          className="w-full max-w-md rounded-2xl bg-red-50 border border-red-200 p-6 text-center"
        >
          <p className="text-sm text-red-600">{loadError}</p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void loadPage()}
              className="px-4 py-2 rounded-full bg-white border border-red-300 text-red-600 text-sm"
            >
              再試行
            </button>
            <button
              type="button"
              onClick={() => router.back()}
              className="px-4 py-2 rounded-full bg-gray-100 text-gray-600 text-sm"
            >
              戻る
            </button>
          </div>
        </div>
      </div>
    );
  }

  // メンバーが見つからない (読み込めなかったのとは別。「再試行」ではなく一覧へ戻る導線を出す。#2093 W10)
  if (error || !member) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
        <p data-testid="family-member-detail-not-found" className="text-gray-600 text-sm text-center">
          {error ?? MEMBER_NOT_FOUND_MESSAGE}
        </p>
        <div className="flex justify-center gap-3">
          <Link
            href={FAMILY_MEMBERS_PATH}
            className="px-4 py-2 rounded-full bg-green-500 text-white text-sm font-medium hover:bg-green-600 transition-colors"
          >
            メンバーの一覧へ
          </Link>
          <button
            onClick={() => router.back()}
            className="px-4 py-2 rounded-full bg-gray-100 text-gray-600 text-sm"
          >
            戻る
          </button>
        </div>
      </div>
    );
  }

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
        <div className="flex items-center gap-3">
          <span className="text-3xl">
            {member.role === 'representative' ? '👑' : member.role === 'adult' ? '👤' : '🧒'}
          </span>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {member.display_name ?? '名前未設定'}
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">{familyRoleLabel(member.role)}</p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* 基本情報 */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">
            基本情報
          </h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">役割</span>
              <span className="text-gray-800 font-medium">{familyRoleLabel(member.role)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">参加日</span>
              <span className="text-gray-800">
                {new Date(member.joined_at).toLocaleDateString('ja-JP')}
              </span>
            </div>
            {member.role === 'child' && (
              <div className="flex justify-between">
                <span className="text-gray-500">アカウント</span>
                <span className="text-gray-800">{member.user_id ? 'あり' : 'なし'}</span>
              </div>
            )}
            {member.role === 'child' && member.birth_date && (
              <div className="flex justify-between">
                <span className="text-gray-500">生年月日</span>
                <span className="text-gray-800">
                  {formatBirthDate(member.birth_date)} ({calculateAgeYears(member.birth_date, todayLocal())}歳)
                </span>
              </div>
            )}
          </div>
        </div>

        {/* #1173: 保護者の同意 (子供のとき) */}
        {member.role === 'child' && consent && consent.revoked_at === null && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 space-y-2" data-testid="parental-consent-card">
            <h2 className="text-sm font-bold text-gray-900">{PARENTAL_CONSENT_COPY.recordedHeading}</h2>
            <div className="space-y-1 text-sm text-gray-700">
              <div>署名: {consent.signed_name}</div>
              <div>同意日時: {formatJstDateTime(consent.signed_at)}</div>
              <div>同意書の版: {consent.consent_version}</div>
            </div>
            <Link
              href={PARENTAL_CONSENT_DOCUMENT_PATH}
              className="inline-block text-sm font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800"
            >
              {PARENTAL_CONSENT_COPY.readFullTextLabel}
            </Link>
            <p className="text-xs text-gray-500">{PARENTAL_CONSENT_COPY.withdrawNote}</p>
          </div>
        )}
        {member.role === 'child' && consent && consent.revoked_at !== null && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 space-y-2" data-testid="parental-consent-card">
            <h2 className="text-sm font-bold text-gray-900">{PARENTAL_CONSENT_COPY.revokedHeading}</h2>
            <div className="text-sm text-gray-700">取り消し日時: {formatJstDateTime(consent.revoked_at)}</div>
          </div>
        )}
        {member.role === 'child' &&
          !consent &&
          member.birth_date &&
          !requiresParentalConsent(member.birth_date, todayLocal()) && (
            <p className="text-xs text-gray-500" data-testid="parental-consent-not-required">
              {PARENTAL_CONSENT_COPY.notRequiredNote}
            </p>
          )}

        {/* 自分の場合: 共有設定 */}
        {isSelf && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">
              共有設定
            </h2>
            <p className="text-xs text-gray-400 mb-4">家族に公開する情報を選択できます</p>
            <div className="space-y-4">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-gray-800">食事記録</div>
                  <div className="text-xs text-gray-400">献立・食べたものを共有</div>
                </div>
                <button
                  role="switch"
                  aria-checked={shareMeals}
                  onClick={() => handleShareUpdate('share_meals', !shareMeals)}
                  disabled={savingShare}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                    shareMeals ? 'bg-green-500' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                      shareMeals ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-gray-800">健康記録</div>
                  <div className="text-xs text-gray-400">体重・血圧などを共有</div>
                </div>
                <button
                  role="switch"
                  aria-checked={shareHealth}
                  onClick={() => handleShareUpdate('share_health', !shareHealth)}
                  disabled={savingShare}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                    shareHealth ? 'bg-green-500' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                      shareHealth ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-gray-800">週間献立</div>
                  <div className="text-xs text-gray-400">週間献立プランを共有</div>
                </div>
                <button
                  role="switch"
                  aria-checked={shareMenu}
                  onClick={() => handleShareUpdate('share_menu', !shareMenu)}
                  disabled={savingShare}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                    shareMenu ? 'bg-green-500' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                      shareMenu ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>
          </div>
        )}

        {/* 他人で権限あり: アクション */}
        {!isSelf && isOwnerOrAdmin && (
          <div className="space-y-3">
            {/* 子供 promote */}
            {member.role === 'child' && !member.user_id && (
              <button
                onClick={() => router.push(`/family/members/${member.id}/promote`)}
                className="w-full rounded-2xl bg-white border border-gray-100 shadow-sm p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
              >
                <span className="text-2xl">🎓</span>
                <div>
                  <div className="font-medium text-gray-800">本人のアカウントとつなぐ</div>
                  <div className="text-xs text-gray-400">
                    ご本人にメールで参加の確認を送り、承認されると自分のアカウントで使えるようになります
                  </div>
                </div>
              </button>
            )}

            {/* 除名 (代表は除名不可) */}
            {member.role !== 'representative' && (
              <button
                onClick={handleRemove}
                disabled={actionLoading}
                className="w-full rounded-2xl bg-white border border-red-100 shadow-sm p-4 flex items-center gap-3 hover:bg-red-50 transition-colors text-left disabled:opacity-50"
              >
                <span className="text-2xl">🚫</span>
                <div>
                  <div className="font-medium text-red-600">家族から外す</div>
                  <div className="text-xs text-gray-400">この操作は取り消せません</div>
                </div>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
