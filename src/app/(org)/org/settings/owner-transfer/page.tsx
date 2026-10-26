"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { normalizeProfileName } from "@/lib/profile-name";

/**
 * 譲渡の候補 (または自分のプロフィール) を読み込めなかったときの文。
 * 候補がいない (「譲渡可能なメンバーがいません」) と見分けるために出す (#2064 R4。組織のメンバーの一覧の MEMBERS_LOAD_ERROR と同じ形)。
 * 読み込みは Supabase の問い合わせで、失敗の理由 (英語の内部の文) は画面に出さない
 */
const CANDIDATES_LOAD_ERROR = '譲渡の候補を読み込めませんでした。しばらくしてから、もう一度お試しください。';

interface CandidateMember {
  id: string;
  nickname: string | null;
  org_role: string;
  joined_org_at: string | null;
}

export default function OwnerTransferPage() {
  const router = useRouter();
  const supabase = createClient();

  const [candidates, setCandidates] = useState<CandidateMember[]>([]);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 候補を読み込めなかったときの文。あるあいだは候補の一覧と「譲渡可能なメンバーがいません」の代わりにこの文と「再試行」を出す (#2064 R4)
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchCandidates = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push('/login');
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('org_role, organization_id')
        .eq('id', user.id)
        .single();

      if (profileError) {
        // 自分のプロフィールを読めなかった (オーナーでないのとは別。メンバーの一覧へ戻さない)
        setLoadError(CANDIDATES_LOAD_ERROR);
        return;
      }
      if (profile?.org_role !== 'owner' || !profile.organization_id) {
        router.push('/org/members');
        return;
      }

      setOrganizationId(profile.organization_id);

      // owner 以外の org メンバーを候補として表示
      const { data: members, error: membersError } = await supabase
        .from('user_profiles')
        .select('id, nickname, org_role, joined_org_at')
        .eq('organization_id', profile.organization_id)
        .neq('id', user.id)
        .neq('org_role', 'owner')
        .order('joined_org_at', { ascending: true });

      if (membersError) {
        // 読み込めなかった (候補がいないのとは別。「譲渡可能なメンバーがいません」と見せない)
        setLoadError(CANDIDATES_LOAD_ERROR);
        return;
      }
      setCandidates(members ?? []);
      setLoadError(null);
    } catch (fetchError) {
      // 問い合わせが例外を投げた (catch が無いと未処理の reject になり、空の一覧の案内が出ていた)
      console.error('Failed to fetch owner transfer candidates:', fetchError);
      setLoadError(CANDIDATES_LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchCandidates();
  }, []);

  // 候補の読み込みをやり直す (読み込めなかったときの「再試行」)。
  // 「再試行」は読み込めなかったとき (フォームを出していないとき) だけ出すので、譲渡の提案の送信とは重ならない
  const retryLoad = () => {
    void fetchCandidates();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserId || !organizationId) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/org/owner-transfer/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization_id: organizationId,
          to_user_id: selectedUserId,
          reason: reason.trim() || null,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error?.message ?? '提案の送信に失敗しました');
        return;
      }

      alert('譲渡提案を送信しました。対象者がメールから承諾すると、オーナーが変更されます。');
      router.push('/org/members');
    } catch {
      setError('ネットワークエラーが発生しました');
    } finally {
      setSubmitting(false);
    }
  };

  const roleLabel = (role: string) => {
    switch (role) {
      case 'admin': return '管理者';
      default: return 'メンバー';
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
    <div className="p-8 max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">オーナーを譲渡</h1>
        <p className="text-gray-500 text-sm mt-1">
          新しいオーナー候補を選んでください。候補者には承諾依頼メールが送信されます。
          譲渡後、あなたの役割は管理者になります。
        </p>
      </div>

      {loadError ? (
        <div
          role="alert"
          data-testid="owner-transfer-load-error"
          className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm"
        >
          <span>{loadError}</span>
          <button
            type="button"
            onClick={retryLoad}
            className="shrink-0 px-3 py-1.5 bg-white border border-red-300 rounded-lg text-red-700 hover:bg-red-100 transition-colors"
          >
            再試行
          </button>
        </div>
      ) : candidates.length === 0 ? (
        // 読み込みに成功して候補が 0 人のときだけ出す
        <div className="bg-white rounded-2xl p-8 shadow-sm border border-gray-100 text-center text-gray-500">
          譲渡可能なメンバーがいません。先にメンバーを招待してください。
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="p-4 border-b border-gray-100">
              <p className="text-sm font-bold text-gray-700">新しいオーナー候補を選択</p>
            </div>
            <div className="divide-y divide-gray-100">
              {candidates.map((candidate) => (
                <label
                  key={candidate.id}
                  className={`flex items-center gap-4 p-4 cursor-pointer hover:bg-gray-50 transition-colors ${
                    selectedUserId === candidate.id ? 'bg-blue-50' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="candidate"
                    value={candidate.id}
                    checked={selectedUserId === candidate.id}
                    onChange={() => setSelectedUserId(candidate.id)}
                    className="text-blue-600"
                  />
                  <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-100 to-blue-50 flex items-center justify-center font-bold text-blue-500 text-xs flex-shrink-0">
                    {(normalizeProfileName(candidate.nickname) ?? 'U')[0].toUpperCase()}
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-gray-900">{normalizeProfileName(candidate.nickname) ?? '(名前なし)'}</p>
                    <p className="text-xs text-gray-500">
                      {roleLabel(candidate.org_role)}
                      {candidate.joined_org_at && (
                        <> — {new Date(candidate.joined_org_at).toLocaleDateString('ja-JP')} 加入</>
                      )}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              譲渡理由 (任意)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="例: 退職のため引き継ぎをお願いします"
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none text-sm"
            />
          </div>

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => router.back()}
              className="flex-1 px-4 py-3 rounded-xl border border-gray-200 text-gray-600 font-medium hover:bg-gray-50 transition-colors"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={!selectedUserId || submitting}
              className="flex-1 px-4 py-3 rounded-xl bg-amber-500 text-white font-bold hover:bg-amber-600 transition-colors disabled:opacity-50 shadow-sm shadow-amber-200"
            >
              {submitting ? '送信中...' : '譲渡を提案'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
