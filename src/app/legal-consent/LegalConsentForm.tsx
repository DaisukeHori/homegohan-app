'use client';

// src/app/legal-consent/LegalConsentForm.tsx
// #1174: 利用規約・プライバシーポリシーへの同意画面 (改定時の再同意ゲート / 新規登録後の初回の同意)
//
// - 利用規約・プライバシーポリシーそれぞれに必須のチェックボックス (required と aria-required="true"。
//   どちらかが未チェックの間は「同意して続ける」を押せない)
// - 「同意して続ける」: POST /api/legal/accept で同意を記録し、元の画面 (next) へ戻る。記録は DB 関数が本人の行だけに行う
// - 「同意しない」: ログアウトして、ご利用いただけないことと、もう一度ログインすれば同意しなくても退会とデータの書き出しができることを案内する
//   (運営が代わりに削除する経路は無いので、お問い合わせによる削除は約束しない。#1901 cross/20 Q-23)
// - #1901 (cross/20 Q-23): 同意しなくても、本人が退会とデータの書き出しをできる画面 (LEGAL_CONSENT_ACCOUNT_PATH = /legal-consent/account) への
//   リンクを、フォームの下と未成年の案内の画面に出す。呼ぶ API (/api/account/delete・/api/account/export) は同意の許可リストにある
// - #1173: 生年月日がプロフィールに無い人 (needsBirthDate) には生年月日の欄を出す (必須)。18 歳未満の自己登録は
//   サーバーが 403 LEGAL_MINOR_SELF_SIGNUP_REFUSED で断り、案内 (生年月日を直す / 登録をやめる = 退会) を出す。
//   保護者の同意とのつながりが無い 18 歳未満の本人 (guardianMissing) には、案内と「登録をやめる」だけを出す。
//   チェックの初期値は生年月日だけを聞く人でもオフのまま (文書ごとの必須のチェックを本人が付ける)
// - 開示・訂正・利用停止・消去の請求の画面 (/settings/data-requests) への案内 (#1751): 規約への同意を条件にできない本人の権利なので、
//   未同意のまま開ける (画面の同意ゲートの対象外・API の許可リスト)。初期設定の前の人 (新規登録の直後) も開ける
//   (初期設定の差し戻しの対象外。lib/onboarding-routing.ts の isDataSubjectRequestsPath)。この人たちには user_profiles の行がまだ無いが、
//   請求の API の認証も行を要さない (src/lib/data-subject-requests/requester-http.ts の authenticateDsrRequester)。
//   フォームの下と「同意しない」の後の案内の 2 か所に出す
//
// 文面へのリンクは同じタブで開く。アプリ (WebView) では target="_blank" のリンクが開けないことがあり、
// 同意の根拠になる文面を読めなくなるのを避けるため。読んだあとはブラウザの「戻る」で、この画面に戻れる。
import { useState } from 'react';
import Link from 'next/link';
import {
  LEGAL_CONSENT_BIRTH_DATE_COPY,
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_LABELS,
  LEGAL_DOCUMENT_PATHS,
  LEGAL_DOCUMENT_TYPES,
  LEGAL_CONSENT_COPY,
  formatLegalEffectiveDate,
  legalConsentAgreeLabel,
  legalConsentReadFullTextLabel,
  legalConsentVersionLine,
  todayLocal,
  validateBirthDate,
  type LegalDocumentType,
} from '@homegohan/shared';
import { createClient } from '@/lib/supabase/client';
import { broadcastSignOut, clearUserScopedLocalStorage } from '@/lib/user-storage';
import { notifyNativeLegalConsentAccepted, notifyNativeSignOut } from '@/lib/native-auth-bridge';
import { LEGAL_CONSENT_ACCOUNT_PATH, LEGAL_CONSENT_PATH } from '@/lib/legal-consent';
import {
  ACCOUNT_DELETE_FAILED_MESSAGE,
  accountDeletionBlockedMessage,
  deleteOwnAccount,
  signOutAfterAccountDeletion,
} from '@/lib/account-self-service';
import { DSR_SETTINGS_ENTRY_TITLE, DSR_SETTINGS_PATH } from '@/lib/data-subject-requests/core';

interface LegalConsentFormProps {
  /** 同意したあとに戻る先 (検証済みの同一オリジンの相対パス) */
  next: string;
  /** すでにいずれかの版に同意していた人か (改定による再同意か、初回の同意か) */
  isReconsent: boolean;
  /** いま有効な版に同意していない文書 */
  outdated: LegalDocumentType[];
  /** プロフィールに生年月日が無い (欄を出して必須にする。#1173) */
  needsBirthDate: boolean;
  /** 18 歳未満の本人で、保護者の同意とのつながりが無い (案内と「登録をやめる」だけを出す。#1173) */
  guardianMissing: boolean;
}

type Phase =
  | 'idle'
  | 'submitting'
  | 'declining'
  | 'declined'
  | 'minor_refused'
  | 'guardian_missing'
  | 'withdrawing'
  | 'withdrawn';

/** 「登録をやめる」の失敗のあとに戻る案内の画面 */
type WithdrawOrigin = 'minor_refused' | 'guardian_missing';

/** 18 歳未満の自己登録を断ったときの応答の code (POST /api/legal/accept の 403) */
const MINOR_REFUSED_CODE = 'LEGAL_MINOR_SELF_SIGNUP_REFUSED';
/** 生年月日が暦に無い日・未来・120 年超のときの応答の code (POST /api/legal/accept の 400) */
const BIRTH_DATE_INVALID_CODE = 'LEGAL_BIRTH_DATE_INVALID';
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;

/** 応答の本文の { error: { code } } を読む (読めなければ null) */
async function readErrorCode(res: Response): Promise<string | null> {
  const body: unknown = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

// 文面は packages/shared の LEGAL_CONSENT_COPY (アプリもこの画面を WebView で開く。#1442 / 設計書 cross/13b)
const GENERIC_ERROR = LEGAL_CONSENT_COPY.acceptFailed;

export default function LegalConsentForm({ next, isReconsent, outdated, needsBirthDate, guardianMissing }: LegalConsentFormProps) {
  const [agreed, setAgreed] = useState<Record<LegalDocumentType, boolean>>({
    terms_of_service: false,
    privacy_policy: false,
  });
  const [phase, setPhase] = useState<Phase>(guardianMissing ? 'guardian_missing' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [birthDate, setBirthDate] = useState('');
  const [birthDateRejected, setBirthDateRejected] = useState(false);
  const [withdrawOrigin, setWithdrawOrigin] = useState<WithdrawOrigin>('minor_refused');

  const allAgreed = LEGAL_DOCUMENT_TYPES.every((type) => agreed[type]);
  const birthDateValid = !needsBirthDate || validateBirthDate(birthDate, todayLocal()) === null;
  // 入力があって受け付けられない値か、サーバーが受け付けなかった (400 LEGAL_BIRTH_DATE_INVALID) とき、欄の下に文を出す
  const showBirthDateInvalid = needsBirthDate && ((birthDate !== '' && !birthDateValid) || birthDateRejected);
  const canSubmit = allAgreed && birthDateValid;
  const busy = phase === 'submitting' || phase === 'declining' || phase === 'withdrawing';

  const handleAccept = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setError(null);
    setNeedsReload(false);
    setBirthDateRejected(false);
    setPhase('submitting');

    try {
      const res = await fetch('/api/legal/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          terms_version: LEGAL_DOCUMENTS.terms_of_service.version,
          privacy_version: LEGAL_DOCUMENTS.privacy_policy.version,
          // 生年月日はプロフィールに無いときだけ送る (行にあればサーバーは無視する)
          ...(needsBirthDate ? { birth_date: birthDate } : {}),
        }),
      });

      if (res.ok) {
        // アプリ (WebView) なら、同意画面の route を閉じてもらう (#1442。普通のブラウザでは何もしない)。次の読み込み直しより先に送る
        notifyNativeLegalConsentAccepted();
        // 画面遷移ではなく読み込み直しで戻る: middleware の判定とサーバー側の画面を、同意後の状態で最初から作らせる
        window.location.assign(next);
        return;
      }
      if (res.status === HTTP_UNAUTHORIZED) {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- セッション切れ (401)。ページごとログインへ移り、middleware に Cookie とログインの状態を判定し直させる
        window.location.assign(
          `/login?next=${encodeURIComponent(`${LEGAL_CONSENT_PATH}?next=${encodeURIComponent(next)}`)}`,
        );
        return;
      }
      if (res.status === HTTP_FORBIDDEN && (await readErrorCode(res)) === MINOR_REFUSED_CODE) {
        // 18 歳未満の自己登録。何も記録されていない。案内 (生年月日を直す / 登録をやめる) を出す
        setPhase('minor_refused');
        return;
      }
      if (res.status === HTTP_BAD_REQUEST && (await readErrorCode(res)) === BIRTH_DATE_INVALID_CODE) {
        setBirthDateRejected(true);
        setPhase('idle');
        return;
      }
      if (res.status === HTTP_CONFLICT) {
        // 画面を開いたまま規約が改定された。読み込み直して、いまの版を読んでもらう
        setNeedsReload(true);
        setError(LEGAL_CONSENT_COPY.versionMismatch);
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
      // WebView ならネイティブへも signOut の前に知らせる (#1038 F7-10。理由は native-auth-bridge.ts の notifyNativeSignOut)。
      // アプリの中で「同意しない」を押したとき、Web だけでなくアプリ側のログインも外す。
      // 順番は notifyNativeSignOut -> signOut -> broadcastSignOut (tests/native-sign-out-order-source-scan.test.ts が検査する)
      notifyNativeSignOut();
      // supabase-js の signOut は、通信に失敗しても例外を投げず { error } を返し、サーバーのセッションは失効しないまま残る
      // (access token が有効なうちなら、この端末の Cookie のセッションは supabase-js が消して SIGNED_OUT を出す。
      // 失効していて更新もできないときは Cookie のセッションも残る)。
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

  // 「登録をやめる」: 本人のアカウントを削除し (既存の退会)、ログアウトして「登録をやめました」を出す。
  // 失敗したら理由の文を出して、元の案内 (minor_refused / guardian_missing) に戻る
  const handleWithdraw = async (origin: WithdrawOrigin) => {
    if (busy) return;
    setError(null);
    setWithdrawOrigin(origin);
    setPhase('withdrawing');
    const result = await deleteOwnAccount();
    if (result.kind === 'deleted') {
      // 端末のデータの消去・ネイティブへの通知・ログアウトの順は signOutAfterAccountDeletion の中
      await signOutAfterAccountDeletion(createClient());
      setPhase('withdrawn');
      return;
    }
    // 409 (家族の代表者・組織のオーナー) はサーバーの文を出す。譲渡の画面への案内はここでは出さない
    // (同意が済んでいない人の譲渡の API は同意ゲートが止めるため)
    setError(result.kind === 'blocked' ? accountDeletionBlockedMessage(result.message) : ACCOUNT_DELETE_FAILED_MESSAGE);
    setPhase(origin);
  };

  if (phase === 'withdrawn') {
    return (
      <div className="space-y-6" data-testid="legal-consent-withdrawn">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">{LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawnHeading}</h1>
          <p className="text-sm leading-relaxed text-gray-600">{LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawnBody}</p>
        </div>
        <Link href="/signup" className="inline-block font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800">
          新規登録の画面へ
        </Link>
      </div>
    );
  }

  // 案内の画面 (退会の送信中も同じ画面のまま、ボタンを無効にする)
  const noticeOrigin: WithdrawOrigin | null =
    phase === 'minor_refused' || phase === 'guardian_missing' ? phase : phase === 'withdrawing' ? withdrawOrigin : null;
  if (noticeOrigin !== null) {
    const origin = noticeOrigin;
    const isGuardianMissing = origin === 'guardian_missing';
    return (
      <div className="space-y-6" data-testid={isGuardianMissing ? 'legal-consent-guardian-missing' : 'legal-consent-minor-refused'}>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            {isGuardianMissing ? LEGAL_CONSENT_BIRTH_DATE_COPY.guardianMissingHeading : LEGAL_CONSENT_BIRTH_DATE_COPY.minorRefusedHeading}
          </h1>
          <p className="text-sm leading-relaxed text-gray-600">
            {isGuardianMissing ? LEGAL_CONSENT_BIRTH_DATE_COPY.guardianMissingBody : LEGAL_CONSENT_BIRTH_DATE_COPY.minorRefusedBody}
          </p>
        </div>

        {error && (
          <div role="alert" className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-sm font-medium text-red-600">
            <p>{error}</p>
          </div>
        )}

        <div className="space-y-3">
          {!isGuardianMissing && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setPhase('idle');
              }}
              disabled={busy}
              className="w-full rounded-full bg-[#FF8A65] py-4 font-bold text-white shadow-lg transition-all duration-300 hover:bg-[#FF7043] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            >
              {LEGAL_CONSENT_BIRTH_DATE_COPY.fixButton}
            </button>
          )}
          <button
            type="button"
            onClick={() => handleWithdraw(origin)}
            disabled={busy}
            className="w-full rounded-full py-3 text-sm font-bold text-gray-500 underline underline-offset-4 hover:text-gray-700 disabled:opacity-50"
          >
            {phase === 'withdrawing' ? '削除しています...' : LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawButton}
          </button>
        </div>

        <AccountEntryLink />
      </div>
    );
  }

  if (phase === 'declined') {
    return (
      <div className="space-y-6" data-testid="legal-consent-declined">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">ご利用を終了しました</h1>
          <p className="text-sm leading-relaxed text-gray-600">
            {LEGAL_CONSENT_COPY.declineUnavailable}ログアウトしました。
          </p>
        </div>

        <section className="space-y-2 rounded-2xl border border-gray-200 bg-gray-50 p-4" data-testid="legal-consent-declined-account-guide">
          <h2 className="font-bold text-gray-900">退会とデータの書き出しについて</h2>
          <p className="text-sm leading-relaxed text-gray-600">{LEGAL_CONSENT_COPY.declinedAccountGuide}</p>
          <Link
            href={`/login?next=${encodeURIComponent(LEGAL_CONSENT_ACCOUNT_PATH)}`}
            className="inline-block font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800"
          >
            {LEGAL_CONSENT_COPY.declinedAccountLink}
          </Link>
          <p className="text-sm leading-relaxed text-gray-600">
            そのほかのご質問は、
            <Link href="/contact" className="font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800">
              お問い合わせフォームへ
            </Link>
            お寄せください。
          </p>
        </section>

        <section className="space-y-2 rounded-2xl border border-gray-200 bg-gray-50 p-4" data-testid="legal-consent-dsr-guide">
          <h2 className="font-bold text-gray-900">{DSR_SETTINGS_ENTRY_TITLE}について</h2>
          <p className="text-sm leading-relaxed text-gray-600">
            ご自身の個人情報の開示・訂正・利用停止・消去の請求は、規約に同意していなくても、ログインのうえ請求の画面から出せます。
          </p>
          <Link
            href={DSR_SETTINGS_PATH}
            className="inline-block font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800"
          >
            請求の画面へ
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
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">{LEGAL_CONSENT_COPY.heading}</h1>
        <p className="text-sm leading-relaxed text-gray-600">
          {isReconsent
            ? outdated.length === 0 && needsBirthDate
              ? LEGAL_CONSENT_BIRTH_DATE_COPY.introBirthDateOnly
              : LEGAL_CONSENT_COPY.introReconsent
            : LEGAL_CONSENT_COPY.introFirst}
        </p>
      </div>

      {needsBirthDate && (
        <div className="space-y-2 rounded-2xl border border-gray-200 p-4" data-testid="legal-consent-birth-date">
          <label htmlFor="legal-consent-birth-date" className="block font-bold text-gray-900">
            {LEGAL_CONSENT_BIRTH_DATE_COPY.label}
          </label>
          <input
            id="legal-consent-birth-date"
            type="date"
            name="birth_date"
            required
            aria-required="true"
            aria-describedby="legal-consent-birth-date-hint"
            aria-invalid={showBirthDateInvalid}
            max={todayLocal()}
            value={birthDate}
            onChange={(e) => {
              setBirthDate(e.target.value);
              setBirthDateRejected(false);
            }}
            disabled={busy}
            className="w-full rounded-xl border border-gray-300 px-3 py-2 text-gray-900"
          />
          <p id="legal-consent-birth-date-hint" className="text-xs text-gray-500">
            {LEGAL_CONSENT_BIRTH_DATE_COPY.hint}
          </p>
          {showBirthDateInvalid && (
            <p role="alert" className="text-xs font-medium text-red-600">
              {LEGAL_CONSENT_BIRTH_DATE_COPY.invalid}
            </p>
          )}
        </div>
      )}

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
                  <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-bold text-orange-700">{LEGAL_CONSENT_COPY.revisedBadge}</span>
                )}
              </div>
              <p className="text-xs text-gray-500">
                {legalConsentVersionLine(version, formatLegalEffectiveDate(effectiveDate))}
              </p>
              <Link
                href={LEGAL_DOCUMENT_PATHS[type]}
                className="inline-block text-sm font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800"
              >
                {legalConsentReadFullTextLabel(label)}
              </Link>
              <label className="flex cursor-pointer items-start gap-3 pt-1">
                <input
                  type="checkbox"
                  name={`agree-${type}`}
                  // 同意は必須であることを、支援技術にも伝える。フォームは noValidate なので、ブラウザの検証で
                  // 送信を止めることはしない (送れるかどうかは、従来どおり「同意して続ける」の無効化で決まる)
                  required
                  aria-required="true"
                  checked={agreed[type]}
                  onChange={(e) => setAgreed((current) => ({ ...current, [type]: e.target.checked }))}
                  disabled={busy}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-[#FF8A65]"
                />
                <span className="text-sm text-gray-800">{legalConsentAgreeLabel(label)}</span>
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
          disabled={!canSubmit || busy}
          className="w-full rounded-full bg-[#FF8A65] py-4 font-bold text-white shadow-lg transition-all duration-300 hover:bg-[#FF7043] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
        >
          {phase === 'submitting' ? '記録しています...' : LEGAL_CONSENT_COPY.acceptButton}
        </button>
        <button
          type="button"
          onClick={handleDecline}
          disabled={busy}
          className="w-full rounded-full py-3 text-sm font-bold text-gray-500 underline underline-offset-4 hover:text-gray-700 disabled:opacity-50"
        >
          {phase === 'declining' ? 'ログアウトしています...' : LEGAL_CONSENT_COPY.declineAndSignOutButton}
        </button>
      </div>

      <p className="text-sm leading-relaxed text-gray-500" data-testid="legal-consent-dsr-link">
        規約に同意していなくても、ご自身の個人情報の開示・訂正・利用停止・消去を請求できます。
        <Link
          href={DSR_SETTINGS_PATH}
          className="font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800"
        >
          {DSR_SETTINGS_ENTRY_TITLE}の画面へ
        </Link>
      </p>

      <AccountEntryLink />
    </form>
  );
}

/** 同意しなくても退会とデータの書き出しができる画面 (/legal-consent/account) への案内 (#1901 cross/20 Q-23) */
function AccountEntryLink() {
  return (
    <p className="text-sm leading-relaxed text-gray-500" data-testid="legal-consent-account-link">
      {LEGAL_CONSENT_COPY.accountEntryLead}
      <Link
        href={LEGAL_CONSENT_ACCOUNT_PATH}
        className="font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800"
      >
        {LEGAL_CONSENT_COPY.accountEntryLink}
      </Link>
    </p>
  );
}
