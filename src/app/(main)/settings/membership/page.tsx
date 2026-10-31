'use client';

// src/app/(main)/settings/membership/page.tsx
// (設計書 membership/03-ui-spec.md §7)
// メンバシップ設定 — 共有設定 toggle + 家族脱退ボタン

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { createClient } from '@/lib/supabase/client';
import { loginPathWithNext, readSignedInUser } from '@/lib/auth/signed-in-user';
import { membershipErrorMessageOfBody } from '@/lib/errors/membership-errors';
import { ChevronLeft, Users, Building2, AlertTriangle } from 'lucide-react';
import type { MembershipScope } from '@/lib/emails/membership/scope-label';
import { SELF_DISSOLVE_COPY } from '@/lib/membership/self-dissolve';
import { SelfDissolveSection } from '@/components/membership/SelfDissolveSection';
import { orgRoleLabel } from '@/lib/membership/role-labels';
import {
  readOwnMembershipAfterNetworkFailure,
  withMembershipStateNote,
  type MembershipLeaveScope,
} from '@/lib/membership/leave-state';
import {
  readOwnShareSettingsAfterNetworkFailure,
  withShareSettingsUnconfirmedNote,
} from '@/lib/membership/share-settings-state';

/**
 * 所属 (自分のプロフィール・家族・組織) を読み込めなかったときの文 (#2073 S3)。所属していない (「所属していません」と
 * 家族グループの作成への案内) と見分けるために出す (家族のメンバーの画面の FAMILY_MEMBERS_LOAD_ERROR と同じ扱い)。
 * 失敗の理由 (英語の内部の文) は画面に出さない
 */
const MEMBERSHIP_LOAD_ERROR = '所属の情報を読み込めませんでした。しばらくしてから、もう一度お試しください。';

/** この画面のパス (ログインのあとに戻る先) */
const MEMBERSHIP_SETTINGS_PATH = '/settings/membership';

/** 共有の設定の更新に失敗したときの文 (応答が届いたうえでの失敗) */
const SHARE_UPDATE_FAILED_MESSAGE = '共有設定の更新に失敗しました';

/** 共有の設定の更新の通信そのものが失敗した (fetch が reject した) ときの文 */
const SHARE_NETWORK_FAILURE_MESSAGE = '共有設定の更新に失敗しました: 通信エラーが発生しました';

/**
 * 脱退の通信そのものが失敗した (fetch が reject した) ときに「…の脱退に失敗しました: 」の後ろに出す理由 (#2064)。
 * 以前は fetch の例外の文 (英語の「Failed to fetch」など) をそのまま出していた。組織のメンバーの画面の脱退と同じ文
 */
const LEAVE_NETWORK_FAILURE_REASON = '通信エラーが発生しました。通信状況を確認して、もう一度お試しください';

/** 脱退に失敗したときの文の頭 (所属ごと) */
const LEAVE_FAILURE_PREFIX = {
  family: '家族からの脱退に失敗しました',
  org: '組織からの脱退に失敗しました',
} as const satisfies Record<MembershipLeaveScope, string>;

// スイッチコンポーネント
const Switch = ({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) => (
  <button
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={onChange}
    disabled={disabled}
    className={`w-12 h-7 rounded-full p-1 transition-colors duration-300 disabled:opacity-40 ${
      checked ? 'bg-[#E07A5F]' : 'bg-gray-200'
    }`}
  >
    <motion.div
      layout
      className="w-5 h-5 bg-white rounded-full shadow-sm"
      animate={{ x: checked ? 20 : 0 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
    />
  </button>
);

interface ShareSettings {
  share_meals: boolean;
  share_health: boolean;
  share_menu: boolean;
}

interface FamilyInfo {
  family_id: string;
  family_name: string;
  role: string;
  share_settings: ShareSettings;
}

interface OrgInfo {
  organization_id: string;
  org_name: string;
  org_role: string;
}

export default function MembershipSettingsPage() {
  const router = useRouter();
  const supabase = createClient();

  const [familyInfo, setFamilyInfo] = useState<FamilyInfo | null>(null);
  const [orgInfo, setOrgInfo] = useState<OrgInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [shareSettings, setShareSettings] = useState<ShareSettings>({
    share_meals: true,
    share_health: false,
    share_menu: true,
  });

  // 脱退確認モーダル
  const [showLeaveFamilyModal, setShowLeaveFamilyModal] = useState(false);
  const [showLeaveOrgModal, setShowLeaveOrgModal] = useState(false);
  const [leaveLoading, setLeaveLoading] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  // 共有の設定の更新に失敗したときの文 (#2073 S2)
  const [shareError, setShareError] = useState<string | null>(null);
  // 所属を読み込めなかったときの文 (#2073 S3。以前は読み込めなかったのを所属していないと見せ、家族グループの作成への案内を出していた)。
  // 一度も読めていないあいだは、所属の区画の代わりにこの文と「再試行」を出す。
  // 読めたあと (解散のあとの読み直し) の失敗は、分かっている所属 (解散した所属は外したもの) の区画を残し、その上にこの文を出す
  const [loadError, setLoadError] = useState<string | null>(null);
  // 所属を一度でも読めたか
  const [hasLoaded, setHasLoaded] = useState(false);

  // #1917 解散の区画を開いている所属 (null は閉じている) と、解散が済んだときの文
  const [dissolveTarget, setDissolveTarget] = useState<MembershipScope | null>(null);
  const [dissolvedNotice, setDissolvedNotice] = useState<string | null>(null);

  // データ取得
  /**
   * 所属を読む。'initial' (画面を開いたとき) だけ全体を読み込み中にする。'refresh' (解散のあと) は画面を保ったまま読み直す。
   * 所属が無い・行が読めないときは familyInfo / orgInfo を null に戻す (解散のあとに古い所属が残らない。#1917)
   */
  const loadData = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (mode === 'initial') setLoading(true);
      // ログインの画面へ移るときは、移るまで読み込み中の表示のままにする (所属していない画面を一瞬出さない)
      let redirecting = false;
      try {
        // getUser は通信の失敗を投げずに { user: null, error } で返す。ログインの画面へ移すのはログインしていないときだけにし、
        // 確かめられなかったときは読み込みの失敗と「再試行」を出す (#2093 W4。以前は通信が切れているだけでもログインの画面へ移していた)。
        // ログインのあとにこの画面へ戻れるよう next を付ける
        const signedIn = await readSignedInUser(supabase);
        if (signedIn.kind === 'load-failed') {
          setLoadError(MEMBERSHIP_LOAD_ERROR);
          return;
        }
        if (signedIn.kind === 'signed-out') {
          redirecting = true;
          router.push(loginPathWithNext(MEMBERSHIP_SETTINGS_PATH));
          return;
        }
        const { user } = signedIn;

        // user_profiles から family_id / organization_id を取得
        const { data: profile, error: profileError } = await supabase
          .from('user_profiles')
          .select('family_id, organization_id, org_role, nickname')
          .eq('id', user.id)
          .single();
        if (profileError) {
          // 自分のプロフィールを読めなかった (所属していないのとは別。「所属していません」と見せない)
          setLoadError(MEMBERSHIP_LOAD_ERROR);
          return;
        }

        // 家族情報
        let nextFamily: FamilyInfo | null = null;
        let nextShareSettings: ShareSettings | null = null;
        if (profile?.family_id) {
          const [{ data: familyMember, error: familyMemberError }, { data: familyGroup, error: familyGroupError }] = await Promise.all([
            supabase
              .from('family_members')
              .select('id, role, share_meals, share_health, share_menu')
              .eq('family_id', profile.family_id)
              .eq('user_id', user.id)
              .eq('status', 'active')
              .maybeSingle(),
            supabase
              .from('family_groups')
              .select('id, name')
              .eq('id', profile.family_id)
              .maybeSingle(),
          ]);

          if (familyMemberError || familyGroupError) {
            // 読み込めなかった (家族にいないのとは別)
            setLoadError(MEMBERSHIP_LOAD_ERROR);
            return;
          }
          if (familyMember && familyGroup) {
            nextFamily = {
              family_id: profile.family_id,
              family_name: familyGroup.name ?? '家族グループ',
              role: familyMember.role,
              share_settings: {
                share_meals: familyMember.share_meals,
                share_health: familyMember.share_health,
                share_menu: familyMember.share_menu,
              },
            };
            nextShareSettings = {
              share_meals: familyMember.share_meals,
              share_health: familyMember.share_health,
              share_menu: familyMember.share_menu,
            };
          }
        }

        // 組織情報
        let nextOrg: OrgInfo | null = null;
        if (profile?.organization_id) {
          const { data: org, error: orgError } = await supabase
            .from('organizations')
            .select('id, name')
            .eq('id', profile.organization_id)
            .maybeSingle();
          if (orgError) {
            // 読み込めなかった (組織に入っていないのとは別)
            setLoadError(MEMBERSHIP_LOAD_ERROR);
            return;
          }
          if (org) {
            nextOrg = {
              organization_id: profile.organization_id,
              org_name: org.name ?? '組織',
              org_role: profile.org_role ?? 'member',
            };
          }
        }
        // 全部読めてから出す
        setFamilyInfo(nextFamily);
        if (nextShareSettings) setShareSettings(nextShareSettings);
        setOrgInfo(nextOrg);
        setLoadError(null);
        setHasLoaded(true);
      } catch (err) {
        console.error('[settings/membership] load error:', err);
        setLoadError(MEMBERSHIP_LOAD_ERROR);
      } finally {
        if (mode === 'initial' && !redirecting) setLoading(false);
      }
    },
    // supabase (createClient) と router は画面を開いたときのものを使う (置き換える前の useEffect の [] と同じ)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    void loadData('initial');
  }, [loadData]);

  /** #1917 解散が済んだ (200)。区画を閉じ、解散した所属をその場で外し、完了の文を出して、もう一方の所属を読み直す */
  const handleDissolved = useCallback(
    (scope: MembershipScope) => {
      setDissolveTarget(null);
      if (scope === 'family') setFamilyInfo(null);
      else setOrgInfo(null);
      setDissolvedNotice(SELF_DISSOLVE_COPY[scope].done);
      void loadData('refresh');
    },
    [loadData],
  );

  // 共有設定の更新
  // Note: PATCH /api/family/members/me/share は P4 implementer 担当のため、
  //       直接 Supabase RPC update_my_share_settings を呼ぶ代替実装
  const handleShareToggle = useCallback(
    async (key: keyof ShareSettings) => {
      if (!familyInfo) return;
      const previous = shareSettings;
      const next = { ...shareSettings, [key]: !shareSettings[key] };
      setShareSettings(next);
      setShareError(null);
      setSaving(true);
      try {
        let res: Response;
        try {
          // P4 担当 endpoint が実装されたら /api/family/members/me/share PATCH に切替
          res = await fetch('/api/family/members/me/share', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: next[key] }),
          });
        } catch (networkFailure) {
          console.error('[settings/membership] share toggle error:', networkFailure);
          // サーバーが更新を済ませてから応答が切れたこともあるので、元に戻さず、サーバーの今の値を読み直して出す (#2073 S2。
          // 以前は元に戻していたので、例えば健康記録の共有はサーバーで有効なのに、画面は無効と見せていた)。
          // 読み直しの応答を待つあいだも切り替えを止めたままにする (saving を戻さない)
          const reread = await readOwnShareSettingsAfterNetworkFailure(supabase);
          if (!reread.ok) {
            // 確かめられなかった: 最後に分かっているサーバーの値 (切り替える前) に戻し、確かめられなかった旨を添える
            setShareSettings(previous);
            setShareError(withShareSettingsUnconfirmedNote(SHARE_NETWORK_FAILURE_MESSAGE));
            return;
          }
          setShareSettings(reread.settings);
          // 更新できていれば、成功のときと同じ (文を出さない)
          if (reread.settings[key] !== next[key]) setShareError(SHARE_NETWORK_FAILURE_MESSAGE);
          return;
        }
        // endpoint 未実装 (501) は許容: 楽観的更新のまま続行
        if (!res.ok && res.status !== 501) {
          // 応答が届いたうえでの失敗は、更新されていないので元に戻す (これまでどおり)
          console.error('[settings/membership] share toggle failed:', res.status);
          setShareSettings(previous);
          setShareError(SHARE_UPDATE_FAILED_MESSAGE);
        }
      } finally {
        setSaving(false);
      }
    },
    [familyInfo, shareSettings, supabase],
  );

  /**
   * 家族・組織の脱退。成功したら確認の区画を閉じて設定へ移る。
   * 通信そのものが失敗した (fetch が reject した) ときは、サーバーが脱退を済ませてから応答が切れたこともあるので、
   * 自分のプロフィールを読み直して確かめる (#2064。以前は確かめず、画面は家族 / 組織に入ったまま残り、もう一度押すと失敗の文が出ていた)。
   * 抜けていれば成功のときと同じ遷移、抜けていなければ失敗の文、確かめられなければ失敗の文に「状態を確かめられませんでした」を添える。
   * 読み直しの応答を待つあいだも「脱退する」を止めたままにする (leaveLoading を戻さない)
   */
  const leaveMembership = async (scope: MembershipLeaveScope) => {
    const closeModal = () => {
      if (scope === 'family') setShowLeaveFamilyModal(false);
      else setShowLeaveOrgModal(false);
    };
    setLeaveLoading(true);
    setLeaveError(null);
    try {
      // 組織脱退は P2 担当 endpoint を呼ぶだけ
      const res = await fetch(scope === 'family' ? '/api/family/leave' : '/api/org/leave', { method: 'POST' });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        // 本文の message は操作ごとの固定の文なので、理由は code から引く (#1478)
        setLeaveError(`${LEAVE_FAILURE_PREFIX[scope]}: ${membershipErrorMessageOfBody(json)}`);
        return;
      }
      closeModal();
      router.push('/settings');
    } catch (leaveFailure) {
      console.error('[settings/membership] leave error:', leaveFailure);
      const membership = await readOwnMembershipAfterNetworkFailure(supabase, scope);
      if (membership === 'left') {
        // 抜けている: 成功のときと同じ遷移
        closeModal();
        router.push('/settings');
        return;
      }
      setLeaveError(withMembershipStateNote(`${LEAVE_FAILURE_PREFIX[scope]}: ${LEAVE_NETWORK_FAILURE_REASON}`, membership));
    } finally {
      setLeaveLoading(false);
    }
  };

  // 家族脱退
  const handleLeaveFamily = () => leaveMembership('family');

  // 組織脱退
  const handleLeaveOrg = () => leaveMembership('org');

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F7F6F3] flex items-center justify-center">
        <div className="animate-spin w-6 h-6 border-2 border-[#E07A5F] border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      {/* ヘッダ */}
      <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 z-10">
        <button
          onClick={() => router.back()}
          className="p-1.5 rounded-full hover:bg-gray-100"
          aria-label="戻る"
        >
          <ChevronLeft size={20} color="#2D2D2D" />
        </button>
        <h1 className="text-lg font-semibold text-gray-800">メンバシップ設定</h1>
        {saving && (
          <div className="ml-auto text-xs text-gray-400">保存中...</div>
        )}
      </div>

      <div className="px-4 py-6 space-y-4 max-w-2xl mx-auto">
        {dissolvedNotice && (
          <p role="status" className="rounded-2xl bg-white px-4 py-3 text-sm text-gray-700 shadow-sm">
            {dissolvedNotice}
          </p>
        )}
        {loadError && (
          <div
            role="alert"
            data-testid="settings-membership-load-error"
            className="flex items-center justify-between gap-3 rounded-2xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700"
          >
            <span>{loadError}</span>
            <button
              type="button"
              onClick={() => void loadData(hasLoaded ? 'refresh' : 'initial')}
              className="shrink-0 px-3 py-1.5 bg-white border border-red-300 rounded-lg text-red-700 hover:bg-red-100 transition-colors"
            >
              再試行
            </button>
          </div>
        )}
        {loadError && !hasLoaded ? null : (
          <>
          {/* 所属組織セクション */}
          <section className="bg-white rounded-2xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Building2 size={16} color="#5B8BC7" />
                <h2 className="text-sm font-semibold text-gray-700">所属組織</h2>
              </div>
            </div>
            <div className="px-4 py-4">
              {orgInfo ? (
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium text-gray-800">{orgInfo.org_name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      役割: {orgRoleLabel(orgInfo.org_role)}
                    </p>
                  </div>
                  {orgInfo.org_role === 'owner' ? (
                    // #1917: オーナーは脱退できない (IS_ORG_OWNER) ので、譲渡と解散を出す (docs/design/family/11-self-dissolve.md §15.1)
                    <div className="flex items-center gap-3">
                      <button
                        className="text-sm text-blue-500 font-medium"
                        onClick={() => router.push('/org/settings/owner-transfer')}
                      >
                        オーナーを譲渡
                      </button>
                      <button
                        className="text-sm text-red-500 font-medium"
                        onClick={() => { setDissolvedNotice(null); setDissolveTarget('organization'); }}
                      >
                        組織を解散
                      </button>
                    </div>
                  ) : (
                    <button
                      className="text-sm text-red-500 font-medium"
                      onClick={() => { setLeaveError(null); setShowLeaveOrgModal(true); }}
                    >
                      組織から脱退
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-gray-500">所属していません</p>
                  {/* 組織をユーザー自身で作る機能は無く、参加は招待メールのリンクからだけ。
                      以前の「組織を作成・参加」ボタンは /org (組織の管理者専用) に送るだけで行き止まりだった (#1143, #1123) */}
                  <p className="text-xs text-gray-400">
                    組織への参加は、組織から届いた招待メールのリンクから行えます。
                  </p>
                </div>
              )}
            </div>
          </section>
          {orgInfo && dissolveTarget === 'organization' && (
            <SelfDissolveSection
              scope="organization"
              scopeId={orgInfo.organization_id}
              scopeName={orgInfo.org_name}
              surface="settings"
              onDissolved={() => handleDissolved('organization')}
              onCancel={() => setDissolveTarget(null)}
              onUnauthorized={() => router.push(loginPathWithNext(MEMBERSHIP_SETTINGS_PATH))}
            />
          )}

          {/* 所属家族セクション */}
          <section className="bg-white rounded-2xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Users size={16} color="#E07A5F" />
                <h2 className="text-sm font-semibold text-gray-700">所属家族</h2>
              </div>
            </div>
            <div className="px-4 py-4">
              {familyInfo ? (
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium text-gray-800">{familyInfo.family_name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      役割:{' '}
                      {familyInfo.role === 'representative'
                        ? '代表'
                        : familyInfo.role === 'child'
                        ? '子供'
                        : '大人'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      className="text-sm text-blue-500 font-medium"
                      onClick={() => router.push('/family/members')}
                    >
                      家族を表示
                    </button>
                    {familyInfo.role === 'representative' ? (
                      // #1917: 代表者は脱退できない (IS_FAMILY_REPRESENTATIVE) ので、譲渡と解散を出す (docs/design/family/11-self-dissolve.md §15.1)
                      <>
                        <button
                          className="text-sm text-blue-500 font-medium"
                          onClick={() => router.push('/family/representative-transfer')}
                        >
                          代表者を譲渡
                        </button>
                        <button
                          className="text-sm text-red-500 font-medium"
                          onClick={() => { setDissolvedNotice(null); setDissolveTarget('family'); }}
                        >
                          家族グループを解散
                        </button>
                      </>
                    ) : (
                      <button
                        className="text-sm text-red-500 font-medium"
                        onClick={() => { setLeaveError(null); setShowLeaveFamilyModal(true); }}
                      >
                        家族から脱退
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-gray-500">所属していません</p>
                  <button
                    className="text-sm text-blue-500 font-medium"
                    onClick={() => router.push('/family/setup')}
                  >
                    家族グループを作成・参加
                  </button>
                </div>
              )}
            </div>
          </section>
          {familyInfo && dissolveTarget === 'family' && (
            <SelfDissolveSection
              scope="family"
              scopeId={familyInfo.family_id}
              scopeName={familyInfo.family_name}
              surface="settings"
              onDissolved={() => handleDissolved('family')}
              onCancel={() => setDissolveTarget(null)}
              onUnauthorized={() => router.push(loginPathWithNext(MEMBERSHIP_SETTINGS_PATH))}
            />
          )}

          {/* 家族への共有設定セクション */}
          {familyInfo && (
            <section className="bg-white rounded-2xl shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <h2 className="text-sm font-semibold text-gray-700">家族への共有設定</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  後で変更できます
                </p>
              </div>
              <div className="px-4 py-3 space-y-1">
                {/* 食事記録 */}
                <div className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-700">食事記録を家族に見せる</p>
                    <p className="text-xs text-gray-400 mt-0.5">献立・食べたもの</p>
                  </div>
                  <Switch
                    checked={shareSettings.share_meals}
                    onChange={() => handleShareToggle('share_meals')}
                    label="食事記録の共有"
                    disabled={saving}
                  />
                </div>
                <div className="h-px bg-gray-100" />
                {/* 健康記録 */}
                <div className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-700">健康記録を家族に見せる</p>
                    <p className="text-xs text-gray-400 mt-0.5">体重・血圧</p>
                  </div>
                  <Switch
                    checked={shareSettings.share_health}
                    onChange={() => handleShareToggle('share_health')}
                    label="健康記録の共有"
                    disabled={saving}
                  />
                </div>
                <div className="h-px bg-gray-100" />
                {/* 週間献立 */}
                <div className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-700">週間献立を家族に見せる</p>
                    <p className="text-xs text-gray-400 mt-0.5">週間の献立プラン</p>
                  </div>
                  <Switch
                    checked={shareSettings.share_menu}
                    onChange={() => handleShareToggle('share_menu')}
                    label="週間献立の共有"
                    disabled={saving}
                  />
                </div>
                {shareError && (
                  <p role="alert" data-testid="settings-share-error" className="pt-2 text-sm text-red-500">
                    {shareError}
                  </p>
                )}
              </div>
            </section>
          )}
          </>
        )}
      </div>

      {/* 家族脱退確認モーダル */}
      {showLeaveFamilyModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={() => !leaveLoading && setShowLeaveFamilyModal(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle size={20} color="#D64545" />
              <h3 className="text-base font-semibold text-gray-800">家族から脱退しますか?</h3>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              「{familyInfo?.family_name}」から脱退します。脱退後は家族の食事記録が見えなくなります。
              記録済みの食事データは削除されません。
            </p>
            {leaveError && (
              <p className="text-sm text-red-500 mb-3">{leaveError}</p>
            )}
            <div className="flex gap-3">
              <button
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                onClick={() => setShowLeaveFamilyModal(false)}
                disabled={leaveLoading}
              >
                キャンセル
              </button>
              <button
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ backgroundColor: '#D64545' }}
                onClick={handleLeaveFamily}
                disabled={leaveLoading}
              >
                {leaveLoading ? '処理中...' : '脱退する'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 組織脱退確認モーダル */}
      {showLeaveOrgModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={() => !leaveLoading && setShowLeaveOrgModal(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle size={20} color="#D64545" />
              <h3 className="text-base font-semibold text-gray-800">組織から脱退しますか?</h3>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              「{orgInfo?.org_name}」から脱退します。組織 Owner の場合は先にオーナーを譲渡してください。
            </p>
            {leaveError && (
              <p className="text-sm text-red-500 mb-3">{leaveError}</p>
            )}
            <div className="flex gap-3">
              <button
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                onClick={() => setShowLeaveOrgModal(false)}
                disabled={leaveLoading}
              >
                キャンセル
              </button>
              <button
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ backgroundColor: '#D64545' }}
                onClick={handleLeaveOrg}
                disabled={leaveLoading}
              >
                {leaveLoading ? '処理中...' : '脱退する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
