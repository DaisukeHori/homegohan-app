'use client';

// (設計書 03-ui-spec.md §12.2, 02-flow-spec.md §6)
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { MEMBERSHIP_STATE_UNCONFIRMED_NOTE, readOwnMembershipAfterNetworkFailure } from '@/lib/membership/leave-state';

/** 作成の通信そのものが失敗した (fetch が reject した) ときの文 */
const NETWORK_FAILURE_MESSAGE = '通信エラーが発生しました';

export default function FamilySetupPage() {
  const router = useRouter();
  const supabase = createClient();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('家族グループ名を入力してください');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/family/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });

      const json = await res.json();

      if (!res.ok) {
        if (json.error?.code === 'ALREADY_IN_FAMILY') {
          setError('既に家族グループに所属しています。まず現在の家族から脱退してください。');
        } else {
          setError(json.error?.message ?? '家族グループの作成に失敗しました');
        }
        return;
      }

      router.push('/family/dashboard');
    } catch (err) {
      console.error('[family/setup] error:', err);
      // サーバーが家族グループを作ってから応答が切れたこともあるので、自分のプロフィールを読み直して確かめる (#2073 S2。
      // 以前は確かめずに通信エラーの文を出し、もう一度送ると「既に家族グループに所属しています。まず現在の家族から脱退してください」と出ていた)。
      // 作成の RPC は、同じトランザクションで本人の user_profiles.family_id を新しい家族にする。
      // 読み直しの応答を待つあいだも「作成」を止めたままにする (loading を戻さない)
      const membership = await readOwnMembershipAfterNetworkFailure(supabase, 'family');
      if (membership === 'still-member') {
        // 家族に入っている (作れている): 成功のときと同じ遷移
        router.push('/family/dashboard');
        return;
      }
      // 作れていない: これまでどおり通信エラーの文。確かめられなかったときは「状態を確かめられませんでした」を添える
      setError(
        membership === 'unknown' ? `${NETWORK_FAILURE_MESSAGE} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})` : NETWORK_FAILURE_MESSAGE,
      );
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
        <h1 className="text-2xl font-bold text-gray-900">家族グループを作成</h1>
        <p className="text-xs text-gray-400 mt-1">家族で献立や食事記録を共有できます</p>
      </div>

      <div className="p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* 家族グループ名 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              家族グループ名
              <span className="text-red-500 ml-1">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 山田家"
              maxLength={60}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
              disabled={loading}
            />
            <p className="text-xs text-gray-400 mt-1">{name.length}/60 文字</p>
          </div>

          {/* エラー */}
          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">
              {error}
            </div>
          )}

          {/* 送信ボタン */}
          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="w-full rounded-full bg-green-500 py-4 text-white font-bold text-base hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? '作成中…' : '家族グループを作る'}
          </button>
        </form>

        {/* 説明 */}
        <div className="mt-8 bg-green-50 border border-green-100 rounded-2xl p-4">
          <p className="text-sm font-medium text-green-700 mb-2">家族グループでできること</p>
          <ul className="text-xs text-green-600 space-y-1">
            <li>・ 献立や食事記録を家族で共有</li>
            <li>・ 家族の食事を一覧で確認</li>
            <li>・ 買い物リストの共有</li>
            <li>・ 共有する情報は個別に設定可能</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
