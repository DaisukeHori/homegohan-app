/**
 * 利用規約・プライバシーポリシーの文面の型と、文面が埋める製品の定数の写し (#1901・設計書 cross/20 §8.1)。
 * React を import しない (サーバー・テスト・将来のモバイルから素のまま読める)。
 */
import type { LegalDocumentType } from '@homegohan/shared';

/** AI 事業者の 1 行 (src/lib/ai/consent-config.ts の AiConsentProviderInfo の表示用の写し。ページが作る) */
export interface AiProviderLine {
  readonly name: string;
  readonly country: string;
  readonly usage: string;
}

/**
 * 文面の中で製品の定数から埋める値。ページ (src/app/terms, src/app/privacy) が src/lib/business-info.ts の定数から組み立てる。
 * 事業者の情報の値は、特定商取引法に基づく表記 (/legal) と運営会社 (/company) と同じ定数から出す (#1911)。
 */
export interface LegalTextContext {
  /** 事業者の正式名称 (BUSINESS_NAME) */
  readonly businessName: string;
  /** 所在地 (BUSINESS_ADDRESS) */
  readonly businessAddress: string;
  /** 代表者 (BUSINESS_REPRESENTATIVE) */
  readonly businessRepresentative: string;
  /** 電話番号の欄に出す文 (PHONE_DISCLOSED_ON_REQUEST。番号は載せない) */
  readonly phoneDisclosure: string;
  /** 連絡先のメールアドレス (BUSINESS_EMAIL) */
  readonly businessEmail: string;
  /** 営業時間 (BUSINESS_HOURS) */
  readonly businessHours: string;
  /** AI 事業者の一覧 (AI_CONSENT_PROVIDERS の順)。利用規約では空でよい */
  readonly aiProviders: readonly AiProviderLine[];
}

export type LegalBlock =
  | { readonly kind: 'p'; readonly text: string }
  | { readonly kind: 'ul'; readonly items: readonly string[] }
  | { readonly kind: 'ol'; readonly items: readonly string[] }
  | { readonly kind: 'table'; readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'links'; readonly items: readonly { readonly label: string; readonly href: string }[] }
  | { readonly kind: 'ai_providers'; readonly providers: readonly AiProviderLine[] }
  | { readonly kind: 'contact'; readonly lines: readonly string[]; readonly email: string };

export interface LegalSection {
  /** ページ内のアンカー (例: terms-9)。他の画面が /terms#terms-9 で参照できる */
  readonly id: string;
  /** h3 の文 (条の見出し。番号を含む) */
  readonly heading: string;
  readonly blocks: readonly LegalBlock[];
}

export interface LegalChapter {
  readonly id: string;
  /** h2 の文。null なら h2 を出さない (プライバシーポリシーは章を持たない) */
  readonly title: string | null;
  readonly sections: readonly LegalSection[];
}

export interface LegalDocumentText {
  readonly type: LegalDocumentType;
  /** 条の前に出す前文 (無ければ省略) */
  readonly preamble?: readonly LegalBlock[];
  readonly chapters: readonly LegalChapter[];
}

/**
 * 文面からリンクするページ。既存の公開のページのパス (定数が無いものはここで決める)。
 * 文書 (利用規約・プライバシーポリシー・保護者の同意書) と開示等の請求の画面は @homegohan/shared の定数を文面モジュールが直接 import する。
 * ログインの後の設定の画面へのリンクは置かない (cross/20 §6 の規則)。
 */
export const CONTACT_PATH = '/contact';
export const LEGAL_NOTICE_PATH = '/legal';
export const GUIDE_PATH = '/guide';

/**
 * 文面が埋める数。製品の定数・migration・設計書の値の写しで、tests/legal-text-1901.test.ts が正本と突き合わせる
 * (文面モジュールに意味のある数を直接書かないための置き場。正本が変わったらここも変え、内容が変わるならポリシーの版を上げる)。
 */
export const LEGAL_FACTS = {
  /** 18 歳未満は保護者の同意 (packages/shared/src/parental-consent.ts ADULT_AGE_YEARS) */
  adultAgeYears: 18,
  /** 13 歳未満の本人アカウントは作らない (同 COPPA_AGE_YEARS) */
  coppaAgeYears: 13,
  /** 非表示にしたコンテンツを消すまでの日数 (src/lib/admin/hidden-content-restore.ts HIDDEN_CONTENT_RETENTION_DAYS) */
  hiddenContentRetentionDays: 90,
  /** app_logs の保持 (supabase/migrations/20251126124224_create_meal_planner_tables.sql の DELETE ... INTERVAL '30 days') */
  appLogRetentionDays: 30,
  /** 失効したセッションの記録の保持 (src/lib/auth/sessions/constants.ts LOGIN_HISTORY_RETENTION_DAYS) */
  loginHistoryRetentionDays: 90,
  /** 無操作で失効するまでの日数 (同 SESSION_IDLE_EXPIRE_DAYS) */
  sessionIdleExpireDays: 30,
  /** 送れた送信待ちの行の保持 (email_outbox / push_outbox の migration の c_sent_retention) */
  outboxSentRetentionDays: 7,
  /** 送れなかった行の保持 (同 c_dead_retention) */
  outboxDeadRetentionDays: 30,
  /** バックアップの保持 (docs/design/cross/17-backup-automation.md §9.1 の R2 Lifecycle) */
  backupDailyRetentionDays: 30,
  backupWeeklyRetentionDays: 366,
  backupAnnualRetentionDays: 2557,
  /** 年次の保持を年で言い直した値 (2,557 日 = 7 年。cross/17 §9.1 の表記) */
  backupAnnualRetentionYears: 7,
  /** 開示等の請求の応答期限の既定 (src/lib/data-subject-requests/core.ts DSR_RESPONSE_DUE_DAYS_DEFAULT。環境変数 DSR_RESPONSE_DUE_DAYS で上書きされうるので「目安」と書く) */
  dsrResponseDueDaysDefault: 30,
  /**
   * 解散した家族グループを物理削除するまでの日数。正本は削除のジョブの関数 purge_dissolved_family_groups の最新の定義の
   * c_retention (supabase/migrations/20261018010000_purge_dissolved_family_groups.sql の interval '90 days')。
   * 保護者の同意の記録 (parental_consents) を持つグループは、この日数を過ぎても消さない (同じ関数の NOT EXISTS)
   */
  dissolvedFamilyGroupRetentionDays: 90,
} as const;
