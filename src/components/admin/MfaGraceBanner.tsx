/**
 * 運営の画面の上に出す、二段階認証の登録の猶予のバナー (#1176。docs/design/cross/12-operator-mfa.md §15.3。段 B)
 *
 * requireRoleForPage の戻りの assurance.decision が 'pass_grace' のとき (必須ロール・未登録・OPERATOR_MFA_ENFORCE_FROM の前)、
 * 運営の layout 3 つと (support) 区画の server layout が描く。API も状態も持たないので Server Component のまま描ける ("use client" にしない)。
 */
import Link from 'next/link';

/** 登録の画面 (MFA_PAGE_PATHS.setup と同じ文字列。page-guard.ts はサーバーの判定を持つので部品からは import しない) */
const MFA_SETUP_PATH = '/settings/security/mfa/setup';

/** 期日を日本時間の「MM/DD HH:mm」で出す (運営の画面の日時は日本時間に固定する。src/lib/admin/format-datetime.ts と同じ方針) */
const JST_MONTH_DAY_TIME = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** ISO 8601 の日時を日本時間の「MM/DD HH:mm」にする。読めない文字列はそのまま返す */
export function formatMfaGraceDeadline(enforceFrom: string): string {
  const date = new Date(enforceFrom);
  if (Number.isNaN(date.getTime())) return enforceFrom;
  const parts = new Map(JST_MONTH_DAY_TIME.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.get('month')}/${parts.get('day')} ${parts.get('hour')}:${parts.get('minute')}`;
}

export interface MfaGraceBannerProps {
  /** 強制の開始日時 (ISO 8601。requireRole の assurance.enforce_from) */
  enforceFrom: string;
  /** 登録の後に戻る先 (この区画のパス。cross/12 §13.4.2 の表の値) */
  next: string;
}

export function MfaGraceBanner({ enforceFrom, next }: MfaGraceBannerProps) {
  return (
    <div
      role="status"
      data-testid="mfa-grace-banner"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-6 py-3 text-sm text-amber-900"
    >
      <span>{formatMfaGraceDeadline(enforceFrom)} までに認証アプリを登録してください</span>
      <Link
        href={`${MFA_SETUP_PATH}?next=${encodeURIComponent(next)}`}
        data-testid="mfa-grace-banner-setup"
        className="font-bold underline hover:no-underline"
      >
        今すぐ登録する
      </Link>
    </div>
  );
}
