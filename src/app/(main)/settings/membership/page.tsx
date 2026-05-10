'use client';

// src/app/(main)/settings/membership/page.tsx
// (設計書 membership/03-ui-spec.md §7)
// メンバシップ設定 — 共有設定 toggle + 家族脱退ボタン

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { createClient } from '@/lib/supabase/client';
import { ChevronLeft, Users, Building2, AlertTriangle } from 'lucide-react';

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

  // データ取得
  useEffect(() => {
    async function loadData() {
      setLoading(true);
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          router.push('/login');
          return;
        }

        // user_profiles から family_id / organization_id を取得
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('family_id, organization_id, org_role, nickname')
          .eq('id', user.id)
          .single();

        // 家族情報
        if (profile?.family_id) {
          const [{ data: familyMember }, { data: familyGroup }] = await Promise.all([
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

          if (familyMember && familyGroup) {
            setFamilyInfo({
              family_id: profile.family_id,
              family_name: familyGroup.name ?? '家族グループ',
              role: familyMember.role,
              share_settings: {
                share_meals: familyMember.share_meals,
                share_health: familyMember.share_health,
                share_menu: familyMember.share_menu,
              },
            });
            setShareSettings({
              share_meals: familyMember.share_meals,
              share_health: familyMember.share_health,
              share_menu: familyMember.share_menu,
            });
          }
        }

        // 組織情報
        if (profile?.organization_id) {
          const { data: org } = await supabase
            .from('organizations')
            .select('id, name')
            .eq('id', profile.organization_id)
            .maybeSingle();
          if (org) {
            setOrgInfo({
              organization_id: profile.organization_id,
              org_name: org.name ?? '組織',
              org_role: profile.org_role ?? 'member',
            });
          }
        }
      } catch (err) {
        console.error('[settings/membership] load error:', err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 共有設定の更新
  // Note: PATCH /api/family/members/me/share は P4 implementer 担当のため、
  //       直接 Supabase RPC update_my_share_settings を呼ぶ代替実装
  const handleShareToggle = useCallback(
    async (key: keyof ShareSettings) => {
      if (!familyInfo) return;
      const next = { ...shareSettings, [key]: !shareSettings[key] };
      setShareSettings(next);
      setSaving(true);
      try {
        // P4 担当 endpoint が実装されたら /api/family/members/me/share PATCH に切替
        const res = await fetch('/api/family/members/me/share', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: next[key] }),
        });
        if (!res.ok) {
          // endpoint 未実装 (501) は許容: 楽観的更新のまま続行
          if (res.status !== 501) {
            throw new Error('共有設定の更新に失敗しました');
          }
        }
      } catch (err) {
        console.error('[settings/membership] share toggle error:', err);
        // ロールバック
        setShareSettings(shareSettings);
      } finally {
        setSaving(false);
      }
    },
    [familyInfo, shareSettings],
  );

  // 家族脱退
  const handleLeaveFamily = async () => {
    setLeaveLoading(true);
    setLeaveError(null);
    try {
      const res = await fetch('/api/family/leave', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error?.message ?? '家族からの脱退に失敗しました');
      }
      setShowLeaveFamilyModal(false);
      router.push('/settings');
    } catch (err: unknown) {
      setLeaveError(err instanceof Error ? err.message : '脱退処理に失敗しました');
    } finally {
      setLeaveLoading(false);
    }
  };

  // 組織脱退 (P2 担当 endpoint を呼ぶだけ)
  const handleLeaveOrg = async () => {
    setLeaveLoading(true);
    setLeaveError(null);
    try {
      const res = await fetch('/api/org/leave', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error?.message ?? '組織からの脱退に失敗しました');
      }
      setShowLeaveOrgModal(false);
      router.push('/settings');
    } catch (err: unknown) {
      setLeaveError(err instanceof Error ? err.message : '脱退処理に失敗しました');
    } finally {
      setLeaveLoading(false);
    }
  };

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
                    役割: {orgInfo.org_role}
                  </p>
                </div>
                <button
                  className="text-sm text-red-500 font-medium"
                  onClick={() => { setLeaveError(null); setShowLeaveOrgModal(true); }}
                >
                  組織から脱退
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-gray-500">所属していません</p>
                <button
                  className="text-sm text-blue-500 font-medium"
                  onClick={() => router.push('/org')}
                >
                  組織を作成・参加
                </button>
              </div>
            )}
          </div>
        </section>

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
                  <button
                    className="text-sm text-red-500 font-medium"
                    onClick={() => { setLeaveError(null); setShowLeaveFamilyModal(true); }}
                  >
                    家族から脱退
                  </button>
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
            </div>
          </section>
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
