'use client';

// (設計書 03-ui-spec.md §1.2, 12.2)
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { loginPathWithNext, readSignedInUser } from '@/lib/auth/signed-in-user';
import { MEMBERSHIP_STATE_UNCONFIRMED_NOTE } from '@/lib/membership/leave-state';

/** 招待の送信の通信そのものが失敗した (fetch が reject した) ときの文 */
const NETWORK_FAILURE_MESSAGE = '通信エラーが発生しました';

/**
 * 自分のプロフィールを読み込めなかった・問い合わせが例外を投げたときの文 (#2073 S3)。家族に入っていない (家族の作成の画面へ移す) と
 * 見分けるために出す (家族のメンバーの画面の FAMILY_MEMBERS_LOAD_ERROR と同じ扱い)。失敗の理由 (英語の内部の文) は画面に出さない
 */
const INVITE_PAGE_LOAD_ERROR = '家族の情報を読み込めませんでした。しばらくしてから、もう一度お試しください。';

/** 招待の履歴を読み込めなかったときの文 (#2073。以前は履歴が無いときと同じく、何も出さなかった) */
const INVITES_LOAD_ERROR = '招待の履歴を読み込めませんでした。';

/** この画面のパス (ログインのあとに戻る先) */
const FAMILY_INVITE_PATH = '/family/members/invite';

interface FamilyInvite {
  id: string;
  email: string;
  status: string;
  expires_at: string;
  created_at: string;
}

export default function FamilyInvitePage() {
  const router = useRouter();
  const supabase = createClient();

  const [familyId, setFamilyId] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [customMessage, setCustomMessage] = useState('');
  const [invites, setInvites] = useState<FamilyInvite[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchingInvites, setFetchingInvites] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  // 自分のプロフィールを読み込めなかったときの文。あるあいだはフォームの代わりにこの文と「再試行」を出す (#2073 S3。以前は
  // 家族に入っていないとして家族の作成の画面へ移し、問い合わせが例外を投げると未処理の reject になっていた)
  const [loadError, setLoadError] = useState<string | null>(null);
  // 招待の履歴を読み込めなかったか。あるあいだは履歴の代わりに INVITES_LOAD_ERROR と「再試行」を出す
  const [invitesLoadFailed, setInvitesLoadFailed] = useState(false);

  /** 招待の履歴を読む。読めなければ null (例外は投げない) */
  const readInvites = useCallback(async (): Promise<FamilyInvite[] | null> => {
    try {
      const res = await fetch('/api/family/invites');
      if (!res.ok) return null;
      const json: unknown = await res.json();
      const list = (json as { data?: { invites?: unknown } } | null)?.data?.invites;
      return Array.isArray(list) ? (list as FamilyInvite[]) : null;
    } catch (readFailure) {
      console.error('[family/invite] failed to read invites:', readFailure);
      return null;
    }
  }, []);

  /** 読んだ招待の履歴を画面に出す (読めなかったときは、読み込めなかった旨を出す) */
  const showInvites = (list: FamilyInvite[] | null) => {
    if (list === null) {
      setInvitesLoadFailed(true);
      return;
    }
    setInvites(list);
    setInvitesLoadFailed(false);
  };

  // 自分の家族と招待の履歴を読む。画面を開いたときと「再試行」で呼ぶ
  const loadPage = useCallback(async () => {
    try {
      // getUser は通信の失敗を投げずに { user: null, error } で返す。ログインの画面へ移すのはログインしていないときだけにし、
      // 確かめられなかったときは読み込みの失敗と「再試行」を出す (#2093 W4。以前は通信が切れているだけでもログインの画面へ移していた)。
      // ログインのあとにこの画面へ戻れるよう next を付ける
      const signedIn = await readSignedInUser(supabase);
      if (signedIn.kind === 'load-failed') {
        setLoadError(INVITE_PAGE_LOAD_ERROR);
        return;
      }
      if (signedIn.kind === 'signed-out') {
        router.push(loginPathWithNext(FAMILY_INVITE_PATH));
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
        setLoadError(INVITE_PAGE_LOAD_ERROR);
        return;
      }
      if (!profile?.family_id) {
        router.replace('/family/setup');
        return;
      }

      setFamilyId(profile.family_id);
      setLoadError(null);
    } catch (loadFailure) {
      console.error('[family/invite] load error:', loadFailure);
      setLoadError(INVITE_PAGE_LOAD_ERROR);
      return;
    }

    // 招待履歴取得
    const list = await readInvites();
    if (list === null) {
      setInvitesLoadFailed(true);
    } else {
      setInvites(list);
      setInvitesLoadFailed(false);
    }
    setFetchingInvites(false);
  }, [supabase, router, readInvites]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  // 招待の履歴だけを読み直す (履歴を読み込めなかったときの「再試行」)
  const retryInvites = async () => {
    showInvites(await readInvites());
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    if (!email.trim()) {
      setError('メールアドレスを入力してください');
      return;
    }
    if (!familyId) {
      setError('家族グループが見つかりません');
      return;
    }

    const inviteEmail = email.trim().toLowerCase();
    setLoading(true);
    // 送る前の招待の履歴。通信が失敗したときに、招待を作れていたかを見分けるために使う (#2073 S2)
    const invitesBefore = await readInvites();
    try {
      const res = await fetch('/api/family/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          family_id: familyId,
          email: inviteEmail,
          custom_message: customMessage.trim() || undefined,
        }),
      });

      const json = await res.json();

      if (!res.ok) {
        if (json.error?.code === 'ALREADY_IN_FAMILY') {
          setError('このメールアドレスは既に家族グループのメンバーです');
        } else if (json.error?.code === 'MEMBER_LIMIT_EXCEEDED') {
          setError('メンバー数の上限に達しています');
        } else {
          setError(json.error?.message ?? '招待の送信に失敗しました');
        }
        return;
      }

      setSuccessMsg(`${email} に招待メールを送信しました`);
      setEmail('');
      setCustomMessage('');

      // 招待履歴を再取得
      showInvites(await readInvites());
    } catch (err) {
      console.error('[family/invite] error:', err);
      // サーバーが招待を作ってから応答が切れたこともあるので、招待の履歴を読み直して確かめる (#2073 S2。
      // 以前は確かめずに通信エラーの文を出し、もう一度送ると、相手に招待のメールが 2 通届いていた)。
      // 読み直しの応答を待つあいだも「招待を送信」を止めたままにする (loading を戻さない)
      const invitesAfter = await readInvites();
      if (invitesAfter === null) {
        // 確かめられなかった
        setError(`${NETWORK_FAILURE_MESSAGE} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})`);
        return;
      }
      showInvites(invitesAfter);
      const sentInvites = invitesAfter.filter(
        (invite) => invite.status === 'pending' && invite.email.toLowerCase() === inviteEmail,
      );
      if (invitesBefore === null) {
        // 送る前を読めなかった: その宛先への招待があっても、今回の招待か前からの招待か見分けられない
        setError(
          sentInvites.length > 0 ? `${NETWORK_FAILURE_MESSAGE} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})` : NETWORK_FAILURE_MESSAGE,
        );
        return;
      }
      const beforeIds = new Set(invitesBefore.map((invite) => invite.id));
      if (sentInvites.some((invite) => !beforeIds.has(invite.id))) {
        // 招待を作れている: 成功のときと同じ表示
        setSuccessMsg(`${email} に招待メールを送信しました`);
        setEmail('');
        setCustomMessage('');
        return;
      }
      // 作れていない: これまでどおり通信エラーの文 (送り直してよい)
      setError(NETWORK_FAILURE_MESSAGE);
    } finally {
      setLoading(false);
    }
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case 'pending': return '待機中';
      case 'accepted': return '承諾済';
      case 'rejected': return '拒否済';
      case 'expired': return '期限切れ';
      case 'revoked': return '取消済';
      default: return status;
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'text-yellow-600 bg-yellow-50';
      case 'accepted': return 'text-green-600 bg-green-50';
      case 'rejected': return 'text-red-600 bg-red-50';
      case 'expired': return 'text-gray-500 bg-gray-50';
      case 'revoked': return 'text-gray-400 bg-gray-50';
      default: return 'text-gray-500 bg-gray-50';
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
        <h1 className="text-2xl font-bold text-gray-900">大人メンバーを招待</h1>
        <p className="text-xs text-gray-400 mt-1">メールアドレスに招待リンクを送信します</p>
      </div>

      <div className="p-6 space-y-8">
        {loadError && (
          <div
            role="alert"
            data-testid="family-invite-load-error"
            className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm"
          >
            <span>{loadError}</span>
            <button
              type="button"
              onClick={() => void loadPage()}
              className="shrink-0 px-3 py-1.5 bg-white border border-red-300 rounded-lg text-red-700 hover:bg-red-100 transition-colors"
            >
              再試行
            </button>
          </div>
        )}

        {/* 招待フォーム (自分の家族を読めたときだけ) */}
        {!loadError && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                メールアドレス
                <span className="text-red-500 ml-1">*</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="招待したい方のメールアドレス"
                className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
                disabled={loading}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                メッセージ (任意)
              </label>
              <textarea
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value)}
                placeholder="招待メールに添えるメッセージ"
                rows={3}
                maxLength={500}
                className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100 resize-none"
                disabled={loading}
              />
              <p className="text-xs text-gray-400 mt-1">{customMessage.length}/500 文字</p>
            </div>

            {error && (
              <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">
                {error}
              </div>
            )}
            {successMsg && (
              <div className="rounded-xl bg-green-50 border border-green-200 p-4 text-sm text-green-700">
                {successMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="w-full rounded-full bg-green-500 py-4 text-white font-bold text-base hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? '送信中…' : '招待を送信'}
            </button>
          </form>
        )}

        {/* 子供追加へのリンク */}
        <button
          onClick={() => router.push('/family/members/child/new')}
          className="w-full rounded-2xl bg-white border border-dashed border-gray-300 p-4 text-gray-500 text-sm flex items-center justify-center gap-2 hover:bg-gray-50 transition-colors"
        >
          <span>🧒</span>
          <span>子供を追加 (アカウント不要)</span>
        </button>

        {/* 招待履歴を読み込めなかった (履歴が無いのとは別) */}
        {invitesLoadFailed && (
          <div
            role="alert"
            data-testid="family-invites-load-error"
            className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm"
          >
            <span>{INVITES_LOAD_ERROR}</span>
            <button
              type="button"
              onClick={() => void retryInvites()}
              className="shrink-0 px-3 py-1.5 bg-white border border-red-300 rounded-lg text-red-700 hover:bg-red-100 transition-colors"
            >
              再試行
            </button>
          </div>
        )}

        {/* 招待履歴 */}
        {!fetchingInvites && !invitesLoadFailed && invites.length > 0 && (
          <div>
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 pl-2">
              招待履歴
            </h2>
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              {invites.map((invite, idx) => (
                <div
                  key={invite.id}
                  className={`flex items-center justify-between p-4 ${
                    idx < invites.length - 1 ? 'border-b border-gray-50' : ''
                  }`}
                >
                  <div>
                    <div className="font-medium text-gray-800 text-sm">{invite.email}</div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      期限: {new Date(invite.expires_at).toLocaleDateString('ja-JP')}
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColor(invite.status)}`}>
                    {statusLabel(invite.status)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
