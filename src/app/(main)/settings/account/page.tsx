"use client";

// src/app/(main)/settings/account/page.tsx
// #1187: ログイン中のユーザーが、アプリの中からパスワードとメールアドレスを変更できるようにする。
//
// 以前は、変更できる経路が「パスワードを忘れた方」のリセットメールしか無かった
// (FAQ は「設定画面の『アカウント』から変更できます」と案内していたが、その画面が無かった)。
//
// - パスワード変更: 現在のパスワードで再認証 (signInWithPassword) → updateUser({ password }) →
//   signOut({ scope: 'others' }) で、この端末以外のログインを解除する。
//   再設定 (/auth/reset-password, #1188) は「全端末をログアウトして入り直す」が、ここは操作中の端末を残すので 'others'。
//   Supabase の secure_password_change (supabase/config.toml の [auth.email]。未指定で、既定値は false = ローカルで確認) が
//   有効でも、直前の signInWithPassword で作った新しいセッションは「直近にログインした」扱いなので、追加の確認は要らない。
// - メールアドレス変更: updateUser({ email }, { emailRedirectTo }) で確認メールを送る。
//   Supabase の「Secure email change」(supabase/config.toml の [auth.email] double_confirm_changes。
//   このリポジトリの config.toml は未指定で、CLI の既定値 true が使われる) が有効だと、新しいアドレスと
//   現在のアドレスの両方に確認メールが届き、両方のリンクを開くまで変更されない (ローカルの GoTrue v2.183.0 で確認)。
//   本番の設定はダッシュボードで決まりリポジトリからは読めないため、文言は「現在のアドレスにも届いた場合は」と
//   どちらの設定でも正しい言い方にしている。
// - Google など、メール以外でログインしているユーザーにはフォームを出さず、案内だけを出す
//   (パスワードもメールアドレスも外部サービス側で管理されていて、ここで変えても食い違うだけなので)。

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, ChevronLeft, Info } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { PASSWORD_HINT_TEXT, validatePassword } from "@/lib/auth/validate-password";
import {
  describeEmailChangeError,
  describePasswordChangeError,
  isSessionExpiredAuthError,
} from "@/lib/auth/account-errors";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type SupabaseBrowserClient = ReturnType<typeof createClient>;

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "signed-out" }
  | { kind: "ready"; email: string; provider: string | null };

/** 形式の大まかな確認だけ行う (厳密な検証は Supabase 側がする) */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FIELD_CLASS = "h-12 rounded-xl border-gray-200 focus-visible:ring-[#E07A5F]/30";
const PRIMARY_BUTTON_CLASS =
  "w-full py-3 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

function providerLabel(provider: string | null): string {
  if (provider === "google") return "Google";
  if (provider === "apple") return "Apple";
  return "外部サービス";
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 p-3 rounded-xl bg-red-50 text-red-600">
      <AlertCircle size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
      <span className="text-sm">{message}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// パスワードの変更
// ---------------------------------------------------------------------------
function PasswordChangeSection({ supabase, email }: { supabase: SupabaseBrowserClient; email: string }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // 変更できたとき。othersSignedOut: 他の端末のログアウトまで確認できたか
  const [result, setResult] = useState<{ othersSignedOut: boolean } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    setResult(null);

    // 入力の検証。ここで弾けるものは、どの API も呼ばずに止める
    if (!currentPassword) {
      setError("現在のパスワードを入力してください");
      return;
    }
    if (!newPassword) {
      setError("新しいパスワードを入力してください");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("新しいパスワードと確認用のパスワードが一致しません");
      return;
    }
    const weakReason = validatePassword(newPassword);
    if (weakReason) {
      setError(weakReason);
      return;
    }
    if (newPassword === currentPassword) {
      setError("新しいパスワードは、現在のパスワードと違うものにしてください");
      return;
    }

    setError(null);
    submittingRef.current = true;
    setSubmitting(true);
    let step: "reauth" | "update" = "reauth";
    try {
      // 1) 現在のパスワードで本人確認 (ログイン済みの端末が使われていても、パスワードを知っている人だけが変えられる)。
      //    この呼び出しで、この端末のセッションは新しいものに入れ替わる。
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      });
      if (reauthError) {
        console.error("[settings/account] re-authentication failed:", reauthError.code ?? reauthError.status);
        setError(describePasswordChangeError(reauthError, "reauth"));
        return;
      }

      // 2) 新しいパスワードへ更新
      step = "update";
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) {
        console.error("[settings/account] password update failed:", updateError.code ?? updateError.status);
        setError(describePasswordChangeError(updateError, "update"));
        return;
      }

      // 3) この端末以外のログインを解除する。
      //    scope: 'others' は今のセッションを残す。操作中の端末は使い続けるので、ユーザー別データの削除
      //    (clearUserScopedLocalStorage) も他タブへのサインアウト通知 (broadcastSignOut) も行わない。
      //    パスワードはもう変わっているので、ここが失敗してもエラー画面には戻さず、注意書きを添えて成功を伝える。
      let othersSignedOut = true;
      try {
        const { error: signOutError } = await supabase.auth.signOut({ scope: "others" });
        if (signOutError) throw signOutError;
      } catch (signOutErr) {
        console.error("[settings/account] sign out of other sessions failed:", signOutErr);
        othersSignedOut = false;
      }

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setResult({ othersSignedOut });
    } catch (err) {
      console.error("[settings/account] password change failed unexpectedly:", err);
      setError(describePasswordChangeError(err, step));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <section
      aria-labelledby="password-change-heading"
      data-testid="account-password-section"
      className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-4"
    >
      <div>
        <h2 id="password-change-heading" className="text-base font-bold text-gray-900">
          パスワードを変更
        </h2>
        <p className="text-xs text-gray-500 mt-1">
          変更すると、いま使っている端末以外のログインはすべて解除されます。
        </p>
      </div>

      {result && (
        <div
          role="status"
          data-testid="password-change-success"
          className="flex items-start gap-2 p-3 rounded-xl bg-green-50 text-green-800"
        >
          <CheckCircle2 size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-sm space-y-1">
            <p className="font-bold">パスワードを変更しました。</p>
            {result.othersSignedOut ? (
              <p>
                セキュリティのため、この端末以外のログインはすべて解除しました。他の端末では、新しいパスワードでログインし直してください。
              </p>
            ) : (
              <p>
                ただし、他の端末のログアウトを確認できませんでした。心配な場合は、設定の「ログアウト」でこの端末もログアウトして、新しいパスワードでログインし直してください。
              </p>
            )}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-4" data-testid="password-change-form">
        <div className="space-y-2">
          <Label htmlFor="current-password">現在のパスワード</Label>
          <PasswordInput
            id="current-password"
            name="current-password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            showLabel="現在のパスワードを表示する"
            hideLabel="現在のパスワードを非表示にする"
            className={FIELD_CLASS}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="new-password">新しいパスワード</Label>
          <PasswordInput
            id="new-password"
            name="new-password"
            autoComplete="new-password"
            aria-describedby="new-password-hint"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            showLabel="新しいパスワードを表示する"
            hideLabel="新しいパスワードを非表示にする"
            className={FIELD_CLASS}
          />
          <p id="new-password-hint" className="text-xs text-gray-500">
            {PASSWORD_HINT_TEXT}。
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm-password">新しいパスワード（確認）</Label>
          <PasswordInput
            id="confirm-password"
            name="confirm-password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            showLabel="確認用のパスワードを表示する"
            hideLabel="確認用のパスワードを非表示にする"
            className={FIELD_CLASS}
          />
        </div>

        {error && <ErrorBanner message={error} />}

        <button type="submit" disabled={submitting} className={PRIMARY_BUTTON_CLASS}>
          {submitting ? "変更中…" : "パスワードを変更する"}
        </button>
      </form>

      <p className="text-xs text-gray-400">
        現在のパスワードを思い出せないときは、いったんログアウトして、ログイン画面の「忘れた場合」からパスワードを再設定してください。
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// メールアドレスの変更
// ---------------------------------------------------------------------------
function EmailChangeSection({ supabase, currentEmail }: { supabase: SupabaseBrowserClient; currentEmail: string }) {
  const [newEmail, setNewEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // 確認メールを送った新しいメールアドレス
  const [sentTo, setSentTo] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    setSentTo(null);

    // login / forgot-password と同じく、大文字小文字の違いで別のアドレスと取り違えないよう小文字にそろえる (#288)
    const normalized = newEmail.trim().toLowerCase();
    if (!normalized) {
      setError("新しいメールアドレスを入力してください");
      return;
    }
    if (!EMAIL_PATTERN.test(normalized)) {
      setError("メールアドレスの形式が正しくありません");
      return;
    }
    // Supabase は今と同じアドレスを指定してもエラーにせず何もしない。確認メールが届かないまま
    // 「送りました」と表示してしまわないよう、ここで止める
    if (normalized === currentEmail.trim().toLowerCase()) {
      setError("現在のメールアドレスと同じです。別のメールアドレスを入力してください");
      return;
    }

    setError(null);
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser(
        { email: normalized },
        { emailRedirectTo: `${window.location.origin}/auth/callback` },
      );
      if (updateError) {
        console.error("[settings/account] email change failed:", updateError.code ?? updateError.status);
        setError(describeEmailChangeError(updateError));
        return;
      }
      setSentTo(normalized);
      setNewEmail("");
    } catch (err) {
      console.error("[settings/account] email change failed unexpectedly:", err);
      setError(describeEmailChangeError(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <section
      aria-labelledby="email-change-heading"
      data-testid="account-email-section"
      className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-4"
    >
      <div>
        <h2 id="email-change-heading" className="text-base font-bold text-gray-900">
          メールアドレスを変更
        </h2>
        <p className="text-xs text-gray-500 mt-1">
          新しいメールアドレスに確認メールを送ります。メールのリンクを開くと変更が完了します。
        </p>
      </div>

      {sentTo && (
        <div
          role="status"
          data-testid="email-change-sent"
          className="flex items-start gap-2 p-3 rounded-xl bg-green-50 text-green-800"
        >
          <CheckCircle2 size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-sm space-y-2">
            <p className="font-bold">確認メールを送りました。</p>
            <p>
              <span className="font-medium break-all">{sentTo}</span> に届いたメールのリンクを開いてください。
            </p>
            <p>
              現在のメールアドレス（<span className="break-all">{currentEmail}</span>
              ）にも確認メールが届いた場合は、そちらのリンクも開いてください。セキュリティのため、両方の確認が必要になります。
            </p>
            <p>
              確認がすべて終わるまで、メールアドレスは変更されません。それまでは、今のメールアドレスでログインできます。変更が完了したら、次回から新しいメールアドレスでログインしてください。
            </p>
            <p>メールが届かないときは、迷惑メールフォルダも確認してください。</p>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-4" data-testid="email-change-form">
        <div className="space-y-2">
          <Label htmlFor="new-email">新しいメールアドレス</Label>
          <Input
            id="new-email"
            name="new-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="name@example.com"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        {error && <ErrorBanner message={error} />}

        <button type="submit" disabled={submitting} className={PRIMARY_BUTTON_CLASS}>
          {submitting ? "送信中…" : "確認メールを送る"}
        </button>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Google など、メール以外でログインしている人への案内 (フォームは出さない)
// ---------------------------------------------------------------------------
function ExternalProviderGuidance({ provider, email }: { provider: string | null; email: string }) {
  const label = providerLabel(provider);
  return (
    <section
      aria-labelledby="external-provider-heading"
      data-testid="account-external-provider-guidance"
      className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-3"
    >
      <div className="flex items-start gap-2">
        <Info size={18} className="shrink-0 mt-0.5 text-blue-500" aria-hidden="true" />
        <h2 id="external-provider-heading" className="text-base font-bold text-gray-900">
          {label}アカウントでログインしています
        </h2>
      </div>
      <p className="text-sm text-gray-600">
        このアカウントは{label}のログインで利用しているため、パスワードとメールアドレスはここでは変更できません。
      </p>
      <ul className="text-sm text-gray-600 space-y-2 list-disc pl-5">
        <li>
          パスワード: ログインのパスワードは{label}側で管理されています。変更は{label}のアカウント設定で行ってください。
        </li>
        <li>
          メールアドレス: ログインに使っているのは、{label}アカウントのメールアドレス
          {email ? `（${email}）` : ""}です。
        </li>
      </ul>
      <p className="text-sm text-gray-600">
        メールアドレスを変えたいなど、ご不明な点は{" "}
        <Link href="/contact" className="font-medium text-[#E07A5F] underline underline-offset-2">
          お問い合わせ
        </Link>
        からご連絡ください。
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ページ本体
// ---------------------------------------------------------------------------
export default function AccountSettingsPage() {
  const [supabase] = useState(() => createClient());
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  // 読み込みに失敗したときの「もう一度読み込む」用
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });

    const run = async () => {
      try {
        const { data, error } = await supabase.auth.getUser();
        if (cancelled) return;
        if (error) {
          if (isSessionExpiredAuthError(error)) {
            setLoad({ kind: "signed-out" });
            return;
          }
          throw error;
        }
        const user = data.user;
        if (!user) {
          setLoad({ kind: "signed-out" });
          return;
        }
        const provider = user.app_metadata?.provider;
        setLoad({
          kind: "ready",
          email: user.email ?? "",
          provider: typeof provider === "string" ? provider : null,
        });
      } catch (err) {
        if (cancelled) return;
        console.error("[settings/account] failed to load the user:", err);
        setLoad({ kind: "error" });
      }
    };
    run();

    return () => {
      cancelled = true;
    };
  }, [supabase, attempt]);

  // パスワードとメールアドレスをこの画面で変えられるのは、メールアドレスとパスワードでログインしている人だけ。
  // provider が取れない場合も、フォームは出さない (パスワードを持たない人に「現在のパスワード」を求めないため)
  const canEditCredentials = load.kind === "ready" && load.provider === "email" && load.email !== "";

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="sticky top-0 z-20 bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3">
        <Link
          href="/settings"
          aria-label="設定に戻る"
          className="p-1.5 rounded-full text-gray-700 hover:bg-gray-100"
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </Link>
        <h1 className="text-lg font-bold text-gray-900">アカウント</h1>
      </div>

      <div className="px-4 py-6 space-y-6 max-w-2xl mx-auto">
        {load.kind === "loading" && (
          <div className="flex justify-center py-12" role="status" aria-label="読み込み中">
            <div className="w-6 h-6 border-2 border-[#E07A5F] border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {load.kind === "error" && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-3" data-testid="account-load-error">
            <ErrorBanner message="ログイン情報を読み込めませんでした。通信の状態を確認して、もう一度お試しください。" />
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              className="w-full py-3 rounded-xl font-bold text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors"
            >
              もう一度読み込む
            </button>
          </div>
        )}

        {load.kind === "signed-out" && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-3" data-testid="account-signed-out">
            <p className="text-sm text-gray-600">ログインの有効期限が切れています。もう一度ログインしてください。</p>
            <Link
              href="/login?next=%2Fsettings%2Faccount"
              className="block w-full py-3 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] transition-colors text-center"
            >
              ログイン画面へ
            </Link>
          </div>
        )}

        {load.kind === "ready" && (
          <>
            <section
              aria-labelledby="account-info-heading"
              className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5"
            >
              <h2 id="account-info-heading" className="text-sm font-bold text-gray-700 mb-3">
                ログイン情報
              </h2>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500 shrink-0">メールアドレス</dt>
                  <dd className="font-medium text-gray-900 break-all text-right" data-testid="account-current-email">
                    {load.email}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500 shrink-0">ログイン方法</dt>
                  <dd className="font-medium text-gray-900 text-right">
                    {load.provider === "email" ? "メールアドレスとパスワード" : `${providerLabel(load.provider)}アカウント`}
                  </dd>
                </div>
              </dl>
            </section>

            {canEditCredentials ? (
              <>
                <PasswordChangeSection supabase={supabase} email={load.email} />
                <EmailChangeSection supabase={supabase} currentEmail={load.email} />
              </>
            ) : (
              <ExternalProviderGuidance provider={load.provider} email={load.email} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
