/**
 * #1901 利用規約・プライバシーポリシーの本文 (設計書 docs/design/cross/20-terms-privacy-text.md §13)
 *
 * 文面は src/lib/legal の termsText / privacyText (データ) が正本で、ページは LegalDocumentBody で描くだけ。
 * ここでは、文面が製品の実際の動き・定数・migration・設計書と食い違わないこと、本文の主張が主張の表
 * (tests/legal-claims-1901.ts) と 1 対 1 で対応することを確かめる (T-1〜T-20・T-24〜T-42。T-21〜T-23 は
 * tests/legal-document-body.test.tsx)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ADULT_AGE_YEARS, COPPA_AGE_YEARS, DSR_SETTINGS_ENTRY_TITLE, LEGAL_DOCUMENTS } from '@homegohan/shared';
import { HIDDEN_CONTENT_RETENTION_DAYS } from '@/lib/admin/hidden-content-restore';
import { AI_CONSENT_PROVIDERS, AI_CONSENT_PROVIDER_INFO, AI_CONSENT_SETTINGS_ENTRY_TITLE } from '@/lib/ai/consent-config';
import { ACCOUNT_EXPORT_EXCLUDED, ACCOUNT_EXPORT_TABLES } from '@/lib/account-export-tables';
import { MFA_REQUIRED_ROLES } from '@/lib/auth/mfa/policy';
import { LOGIN_HISTORY_RETENTION_DAYS, SESSION_IDLE_EXPIRE_DAYS } from '@/lib/auth/sessions/constants';
import { DSR_RESPONSE_DUE_DAYS_DEFAULT } from '@/lib/data-subject-requests/core';
import { LegalDocumentBody } from '@/components/legal/LegalDocumentBody';
import {
  CSP_TURNSTILE_ORIGIN,
  HOLIDAYS_API_ORIGIN,
  buildContentSecurityPolicy,
  cspDirectivesOf,
} from '@/lib/security/csp';
// @/lib/legal (index.ts) ではなく各モジュールを直接読む (vitest.config.ts の @/ の解決はディレクトリの index を先に試さないため)
import {
  LEGAL_FACTS,
  type LegalBlock,
  type LegalDocumentText,
  type LegalSection,
  type LegalTextContext,
} from '@/lib/legal/legal-text';
import { PRIVACY_PROCESSORS, PRIVACY_SECTION_COUNT, PRIVACY_SECTION_HEADINGS, privacyText } from '@/lib/legal/privacy-text';
import { TERMS_ARTICLE_COUNT, TERMS_ARTICLE_HEADINGS, TERMS_MEDICAL_DISCLAIMER, termsText } from '@/lib/legal/terms-text';
import { LEGAL_CLAIMS, LEGAL_CLAIM_COUNT } from './legal-claims-1901';
import { stripAllTags } from './helpers/strip-tags';

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

const { default: TermsPage } = await import('@/app/terms/page');
const { default: PrivacyPage } = await import('@/app/privacy/page');

const ROOT = path.resolve(__dirname, '..');
const DESIGN_DOC = 'docs/design/cross/20-terms-privacy-text.md';

/** 設計書 §10.1 のテストの文脈。事業者の情報は仮の値 (src/lib/business-info.ts の値が変わっても字数が動かないように) */
const TEST_CTX: LegalTextContext = {
  businessName: 'TESTCO',
  businessAddress: 'TESTADDRESS',
  businessRepresentative: 'TESTREP',
  phoneDisclosure: 'TESTPHONE',
  businessEmail: 'contact@example.com',
  businessHours: 'TESTHOURS',
  aiProviders: [],
};

/**
 * T-19: 本文に書かない効果・成果の言い回し。根拠: 設計書 cross/20 R-18・§3 の薬機法・景品表示法・健康増進法の行
 */
const LEGAL_TEXT_FORBIDDEN_CLAIMS: readonly string[] = ['健康になれ', '改善します', '効果があります', '痩せ', '治ります', '予防できます'];

/** T-7: evidence.needle の最小の長さ。短い語は根拠のファイル以外にも偶然当たるため (根拠: 設計書 cross/20 §7 の規則) */
const MIN_NEEDLE_LENGTH = 6;

/** T-30: IP アドレス・User-Agent・通信から判定した国を持つ列の名前。根拠: 設計書 cross/20 F-37 */
const IP_UA_COLUMNS: readonly string[] = ['ip_address', 'ip_network', 'user_agent', 'country_code'];

/** T-30: 第3条に載せた、IP・User-Agent を持つ表 → 本文の文。根拠: 設計書 cross/20 F-37 */
const DISCLOSED_IP_UA_TABLES: Readonly<Record<string, string>> = {
  user_sessions_metadata: 'IP アドレスとそのネットワークの範囲',
  terms_acceptances: '利用規約とプライバシーポリシーに同意した版・日時・IP アドレス',
  external_data_consents: '日本国外の事業者への提供に同意した版・日時・IP アドレス',
  parental_consents: '保護者の同意の署名',
};

/** T-30: 第3条に載せない、IP・User-Agent を持つ表 → 理由。根拠: 設計書 cross/20 F-37 */
const EXCLUDED_IP_UA_TABLES: Readonly<Record<string, 'operator_ip' | 'no_writer' | 'not_personal'>> = {
  // 運営担当者の IP (利用者の情報ではない)
  admin_audit_logs: 'operator_ip',
  // 書き込む処理が無い
  cookie_consents: 'no_writer',
  failed_invite_lookups: 'no_writer',
  // 個人の情報でない (料理のデータの取得元)
  catalog_sources: 'not_personal',
};

/** T-14: 文面からリンクしてよいページ (公開のページと開示等の請求の画面)。根拠: 設計書 cross/20 R-28 */
const ALLOWED_LINK_HREFS: readonly string[] = [
  '/terms',
  '/privacy',
  '/legal',
  '/legal/parental-consent',
  '/settings/data-requests',
  '/contact',
  '/guide',
];

/** T-26: アプリの iOS の権限の説明 (UsageDescription) の既知の一覧。根拠: 設計書 cross/20 F-25 (使っていない宣言は §17 の候補) */
const KNOWN_IOS_USAGE_DESCRIPTIONS: readonly string[] = [
  'NSCameraUsageDescription',
  'NSPhotoLibraryUsageDescription',
  'NSPhotoLibraryAddUsageDescription',
];

/** T-26: アプリの Android の権限の既知の一覧。根拠: 設計書 cross/20 F-25 */
const KNOWN_ANDROID_PERMISSIONS: readonly string[] = [
  'CAMERA',
  'READ_MEDIA_IMAGES',
  'READ_EXTERNAL_STORAGE',
  'WRITE_EXTERNAL_STORAGE',
  'POST_NOTIFICATIONS',
  'RECORD_AUDIO',
].map((name) => `android.permission.${name}`);

/** テストとテストの道具を走査の対象から外す */
const TEST_FILE_PATTERN = /(__tests__|__mocks__|\.test\.|\.spec\.)/;

/** T-34: 利用者に紐づく表 → プライバシーポリシー第3条の表の行 (1 列目の値)。根拠: 設計書 cross/20 F-42 */
const PRIVACY_DATA_TABLES: Readonly<Record<string, string>> = {
  password_history: 'アカウント',
  apple_sign_in_tokens: 'アカウント',
  personal_subscriptions: '有料プラン',
  billing_customers: '有料プラン',
  coupon_redemptions: '有料プラン',
  iap_reconcile_attempts: '有料プラン',
  user_profiles: 'プロフィール',
  nutrition_targets: 'プロフィール',
  meals: '食事と献立',
  meal_ai_feedbacks: '食事と献立',
  meal_nutrition_estimates: '食事と献立',
  user_daily_meals: '食事と献立',
  planned_meals: '食事と献立',
  weekly_menus: '食事と献立',
  weekly_menu_requests: '食事と献立',
  pantry_items: '食事と献立',
  shopping_lists: '食事と献立',
  shopping_list_items: '食事と献立',
  shopping_list_requests: '食事と献立',
  meal_image_jobs: '食事と献立',
  nutrition_feedback_cache: '食事と献立',
  derived_recipes: '食事と献立',
  recipes: 'レシピ',
  recipe_collections: 'レシピ',
  recipe_collection_items: 'レシピ',
  recipe_likes: 'レシピ',
  dish_favorites: 'レシピ',
  recipe_comments: 'レシピ',
  health_records: '健康',
  health_goals: '健康',
  health_checkups: '健康',
  health_checkup_longitudinal_reviews: '健康',
  blood_test_results: '健康',
  blood_test_longitudinal_reviews: '健康',
  health_insights: '健康',
  daily_activity_logs: '毎日のコンディション',
  user_performance_checkins: '毎日のコンディション',
  performance_plans: '毎日のコンディション',
  ai_consultation_sessions: 'AI 相談',
  ai_consultation_messages: 'AI 相談',
  ai_action_logs: 'AI 相談',
  health_streaks: '記録の継続と比較',
  health_challenges: '記録の継続と比較',
  user_badges: '記録の継続と比較',
  user_badge_period_awards: '記録の継続と比較',
  user_metrics: '記録の継続と比較',
  user_segment_rankings: '記録の継続と比較',
  family_members: '家族グループ',
  family_groups: '家族グループ',
  family_invites: '家族グループ',
  family_promotion_requests: '家族グループ',
  ownership_transfer_proposals: '家族グループ',
  organizations: '組織',
  organization_challenge_participants: '組織',
  organization_challenge_ranking_exclusions: '組織',
  inquiries: 'お問い合わせ・サポート・請求',
  support_tickets: 'お問い合わせ・サポート・請求',
  support_ticket_messages: 'お問い合わせ・サポート・請求',
  data_subject_requests: 'お問い合わせ・サポート・請求',
  terms_acceptances: '同意の記録',
  external_data_consents: '同意の記録',
  parental_consents: '同意の記録',
  user_sessions_metadata: '端末・利用状況・ログ',
  user_push_tokens: '端末・利用状況・ログ',
  native_bridge_codes: '端末・利用状況・ログ',
  notification_preferences: '端末・利用状況・ログ',
  app_logs: '端末・利用状況・ログ',
  ai_usage_counters: '端末・利用状況・ログ',
  ai_usage_grant_claims: '端末・利用状況・ログ',
  llm_usage_logs: '端末・利用状況・ログ',
  email_outbox: '端末・利用状況・ログ',
  push_outbox: '端末・利用状況・ログ',
  experiment_assignments: '端末・利用状況・ログ',
  admin_user_notes: '運営の記録',
  membership_audit: '運営の記録',
  meal_nutrition_debug_logs: '運営の記録',
  gdpr_deletion_requests: '運営の記録',
  // #1917 の続き (D73。20261023130000): 退会の印 (退会を始めた日時)。第3条の「退会の記録」に当たる。退会が済むと消える (途中で止まったときも消す。20261024120000)
  account_deletion_guards: '運営の記録',
};

/**
 * T-34: 第3条に載せない表と理由。根拠: 設計書 cross/20 F-42
 * no_writer = 書き込む処理が無い。operator_only = 運営担当者だけの情報。
 * 有料プランの表 (billing_customers・coupon_redemptions) は billing/03 §11.5 で第3条の「有料プラン」の行へ移した (PRIVACY_DATA_TABLES)
 */
const PRIVACY_DATA_EXCLUDED: Readonly<Record<string, 'no_writer' | 'operator_only'>> = {
  cookie_consents: 'no_writer',
  csat_feedbacks: 'no_writer',
  nps_surveys: 'no_writer',
  ai_content_logs: 'no_writer',
  recipe_requests: 'no_writer',
  recipe_flags: 'no_writer',
  moderation_flags: 'no_writer',
  announcement_reads: 'no_writer',
  email_delivery_logs: 'no_writer',
  referral_rewards: 'no_writer',
  buddies: 'no_writer',
  buddy_actions: 'no_writer',
  legacy_family_groups: 'no_writer',
  legacy_family_members: 'no_writer',
  family_meal_logs: 'no_writer',
  operator_mfa_backup_codes: 'operator_only',
};

/** T-36: AI 相談の route が読む表 → 第6条の送る情報の項目に含まれる語。根拠: 設計書 cross/20 F-43 */
const AI_CONTEXT_TABLES: Readonly<Record<string, string>> = {
  user_profiles: 'プロフィールの情報',
  user_daily_meals: '食事と献立の記録',
  planned_meals: '食事と献立の記録',
  nutrition_targets: '栄養の目標',
  health_records: '健康の記録',
  health_goals: '健康の目標',
  health_insights: '健康に関するヒント',
  user_badges: '獲得したバッジ',
  shopping_lists: '買い物リスト',
  shopping_list_items: '買い物リスト',
  pantry_items: '冷蔵庫の写真と食材',
  recipe_collections: '保存したレシピ',
  ai_consultation_sessions: 'それまでのやりとりとその要約',
  ai_consultation_messages: 'AI 相談に入力した文章',
  ai_action_logs: 'それまでのやりとりとその要約',
};

/**
 * T-6: 本文に書かない、未完成や予定を示す語。根拠: 設計書 cross/20 R-32・P-9
 * (#1911 の tests/no-pending-wording-1911.test.ts の語に、無い機能を示す書き方を足したもの)
 */
const LEGAL_TEXT_PENDING_WORDS: readonly string[] = [
  '準備中',
  '販売開始前',
  '近日',
  '公開予定',
  '確定次第',
  '決まり次第',
  '決まりましたら',
  '順次整備',
  '予定',
  'まだ',
  '今後',
  '現在、',
  '機能はありません',
  '未対応',
];

/** T-33: 有料プランの条文の語。PAID_TERMS_SECTIONS の節にだけ出てよい。根拠: 設計書 cross/20 R-30・P-9・billing/03 §11.5 */
const LEGAL_TEXT_PAID_TERMS: readonly string[] = [
  '有料',
  '自動更新',
  '自動的に更新',
  '解約',
  '返金',
  '決済',
  'Stripe',
  'RevenueCat',
  'アプリ内課金',
  'App Store',
  'Google Play',
];

/** T-33: 有料の語が出てよい節 (billing/03 §11 が有料の条文を足した節)。ほかの条に足したら赤。根拠: 設計書 billing/03 §11.5 */
const PAID_TERMS_SECTIONS: readonly string[] = [
  'terms-10',
  'terms-16',
  'terms-17',
  'terms-24',
  'privacy-3',
  'privacy-4',
  'privacy-7',
  'privacy-10',
  'privacy-12',
];

/** T-33: 利用規約第10条 (料金) の最初の ol の 11 項 (逐語)。根拠: 設計書 billing/03 §11.1 (a) */
const PAID_TERMS_10_ITEMS: readonly string[] = [
  '本サービスは、無料で利用できます。',
  '当社は、無料で利用できる範囲のほかに、料金を支払って利用する有料プランを提供します。有料プランの種類、各有料プランで利用できる機能と AI 機能の利用回数の上限、料金（税込）、無料体験の有無と期間は、料金のページと特定商取引法に基づく表記に掲げます。',
  '有料プランは、Web では当社が利用する決済の事業者（Stripe）を通じたクレジットカードで、iOS・Android のアプリでは App Store または Google Play のアプリ内課金で申し込むことができます。アプリ内課金の料金、請求、領収、返金は、各ストアの表示と規約に従います。',
  '有料プランは自動更新の定期購入です。ユーザーが解約しない限り、月額または年額の期間ごとに、同じ料金が自動で請求されます。',
  '無料体験のある有料プランでは、無料体験の期間が終わると有料の期間に移り、請求が始まります。無料体験の期間中に解約すると、料金は請求されません。Web で申し込む無料体験は、同じ有料プランにつき 1 回限りです（App Store と Google Play で受けた同じ有料プランの無料体験も数えます）。App Store と Google Play で申し込む無料体験を受けられるかどうかは、各ストアが判定します。',
  '有料プランは、いつでも解約できます。Web で申し込んだ有料プランは本サービスの画面から、App Store または Google Play で申し込んだ有料プランは各ストアの定期購読の管理から解約します。解約しても、支払い済みの期間の終わりまで有料プランを利用できます。',
  '期間の途中の解約による日割りの返金は行いません。法令に定める場合と、本サービスに重大な不具合があった場合を除き、支払い済みの料金は返金しません。',
  '同時に契約できる有料プランは 1 つです。Web とアプリ内課金、または App Store と Google Play の両方で重ねて申し込んだ場合、後から申し込んだ契約は、そのままでは本サービスに反映されません。その場合はお問い合わせからご連絡ください。当社は、二重のお支払いにならないよう、いずれか一方の契約を解約して返金するか、ストアへの返金の申し込みの方法をご案内します。',
  'Web または Google Play で申し込んだ有料プランを別の有料プランに変えるときは、いまの有料プランを解約し、その期間の終わりのあとに新しい有料プランを申し込みます。App Store で申し込んだ有料プランは、App Store の定期購読の管理から有料プランと期間を変えることができ、変更の時期と精算は App Store の規約に従います。',
  '家族プラン（家族 Basic・家族 Pro）を契約した代表者は、プランの人数の上限まで、家族グループにメンバーを迎えることができます。家族プランの契約が終わると、家族グループのメンバーはそのまま残りますが、新しいメンバーを迎えることはできません。',
  '当社は、有料プランの料金を改定することがあります。改定した料金は、改定の後に申し込む契約から適用します。契約中のユーザーの料金を改定するときは、法令と各ストアの規約に従い、事前にお知らせします。',
];

/**
 * T-40: 本文の文と links の label に書かない、画面の名前の引用と道順の形。根拠: 設計書 cross/20 R-28・P-11
 * 「設定の「…」」「設定画面の「…」」「ホームの「…」」「…の画面で」の引用と、v1.11 の links の「設定（…）」の形
 */
const SCREEN_REFERENCE_PATTERNS: readonly RegExp[] = [
  /(?:設定|設定画面|ホーム|メニュー|タブ)の「/,
  /設定（/,
  /「[^」]+」(?:の画面|画面|から開|を開)/,
];

/**
 * T-40: 本文に書かない画面の名前。定数のあるものは import して使う (AI_CONSENT_SETTINGS_ENTRY_TITLE・DSR_SETTINGS_ENTRY_TITLE)。
 * 定数の無いものは v1.11 の本文が引用していた名前。根拠: 設計書 cross/20 F-55・R-28
 */
const SCREEN_NAMES_WITHOUT_CONSTANT: readonly string[] = [
  'ログイン中の端末・ログイン履歴',
  'プランとお支払い',
  '今日のコンディション',
  '週間献立の画面',
];

/** T-41: 健康診断・血液検査・体重計の写真を受け取って読み取るだけで、Storage に書かない処理のファイル。根拠: 設計書 cross/20 F-48・F-52 */
const PHOTO_READ_ONLY_SOURCES: readonly string[] = [
  'src/app/api/ai/analyze-health-checkup/route.ts',
  'src/app/api/ai/analyze-weight-scale/route.ts',
  'supabase/functions/analyze-health-photo/index.ts',
  'apps/mobile/app/health/blood-tests.tsx',
];


/** T-29: 第10条の表と突き合わせる CSP のディレクティブ (外部の送り先を許すもの)。根拠: 設計書 cross/20 F-15 */
const CSP_DISCLOSED_DIRECTIVES: readonly string[] = ['script-src', 'frame-src', 'img-src', 'connect-src'];

/** T-29: CSP の値のうち外部の送り先でないもの (引用符つきのキーワード・nonce と、data: / blob: のスキーム) */
const CSP_NON_EXTERNAL_SOURCE_PATTERN = /^(?:'.*'|data:|blob:)$/;

/**
 * T-29: CSP の外部の許可先 → 第10条の表の 1 列目に含まれる送り先の語。
 * null は「端末からそのホストへ送らない」もので、理由をコメントに書く (T-29 の (3) が理由を確かめる)。根拠: 設計書 cross/20 F-15
 */
const CSP_EXTERNAL_ORIGIN_DISCLOSURE: Readonly<Record<string, string | null>> = {
  '*.supabase.co': 'Supabase',
  'wss://*.supabase.co': 'Supabase',
  '*.vercel.app': 'Vercel',
  // Speed Insights のスクリプトの配信元 (本番は同一オリジンから読むが、CSP は許可している)
  '*.vercel-scripts.com': 'Vercel',
  // Turnstile のスクリプト (script-src) と判定の枠 (frame-src)
  [CSP_TURNSTILE_ORIGIN]: 'Cloudflare',
  [HOLIDAYS_API_ORIGIN]: 'GitHub',
  // ログイン画面の背景の画像。next/image の最適化 (/_next/image) を通り、ブラウザは直接取りに行かない
  'images.unsplash.com': null,
};

/** 主張の単位 (設計書 cross/20 §10.1)。p / ul / ol は「。」で分けた 1 文、table は 1 行。links・ai_providers・contact は単位にしない */
interface LegalTextUnit {
  readonly section: string;
  readonly text: string;
}

const SENTENCE_END = '。';
const TABLE_CELL_JOINER = ' | ';

function legalTextUnits(document: LegalDocumentText): LegalTextUnit[] {
  const units: LegalTextUnit[] = [];
  const pushSentences = (section: string, text: string) => {
    for (const sentence of text.split(SENTENCE_END)) {
      const trimmed = sentence.trim();
      if (trimmed !== '') units.push({ section, text: trimmed });
    }
  };
  const pushBlocks = (section: string, blocks: LegalDocumentText['chapters'][number]['sections'][number]['blocks']) => {
    for (const block of blocks) {
      if (block.kind === 'p') pushSentences(section, block.text);
      else if (block.kind === 'ul' || block.kind === 'ol') block.items.forEach((item) => pushSentences(section, item));
      else if (block.kind === 'table') block.rows.forEach((row) => units.push({ section, text: row.join(TABLE_CELL_JOINER) }));
    }
  };
  const prefix = document.type === 'terms_of_service' ? 'terms' : 'privacy';
  if (document.preamble) pushBlocks(`${prefix}-preamble`, document.preamble);
  for (const chapter of document.chapters) {
    for (const section of chapter.sections) pushBlocks(section.id, section.blocks);
  }
  return units;
}

/** T-40: 本文に書かない画面の名前の全部 (定数のあるものは定数から) */
const SCREEN_NAMES: readonly string[] = [AI_CONSENT_SETTINGS_ENTRY_TITLE, DSR_SETTINGS_ENTRY_TITLE, ...SCREEN_NAMES_WITHOUT_CONSTANT];

// ─── 道具 ─────────────────────────────────────────────────────────────────

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function existsRepo(rel: string): boolean {
  return fs.existsSync(path.join(ROOT, rel));
}

/** dir の下の拡張子が exts のファイル (リポジトリからの相対パス)。node_modules は歩かない */
function listFiles(dir: string, exts: readonly string[]): string[] {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(rel, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(rel);
  }
  return out;
}

/** テストを除いたコードのファイル (.ts / .tsx) */
function listCodeFiles(dirs: readonly string[]): string[] {
  return dirs.flatMap((dir) => listFiles(dir, ['.ts', '.tsx'])).filter((file) => !TEST_FILE_PATTERN.test(file));
}

/** supabase/migrations の .sql (.down.sql を除く) を名前の順に */
function listMigrations(): string[] {
  return listFiles('supabase/migrations', ['.sql'])
    .filter((file) => !file.endsWith('.down.sql'))
    .sort();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 関数の最新の定義 (名前の順で最後に CREATE OR REPLACE するファイルの、一致した位置から次の $$; まで) */
function latestFunctionDefinition(name: string): { file: string; body: string } {
  const pattern = new RegExp(`CREATE OR REPLACE FUNCTION\\s+"?public"?\\."?${escapeRegExp(name)}"?\\s*\\(`);
  let found: { file: string; body: string } | null = null;
  for (const file of listMigrations()) {
    const text = readRepo(file);
    const match = pattern.exec(text);
    if (!match) continue;
    const end = text.indexOf('$$;', match.index);
    found = { file, body: text.slice(match.index, end === -1 ? undefined : end) };
  }
  if (!found) throw new Error(`関数 ${name} の定義が migration に無い`);
  return found;
}

/** migration に INSERT INTO <表> (public. / "public". つきを含む) があるファイル */
function migrationsInsertingInto(table: string): string[] {
  const pattern = new RegExp(`INSERT INTO\\s+(?:"?public"?\\.)?"?${escapeRegExp(table)}"?(?![\\w])`, 'i');
  return listMigrations().filter((file) => pattern.test(readRepo(file)));
}

/** コードの .from('<表>') から次の ; までに .insert( / .upsert( があるか */
function writesTable(source: string, table: string): boolean {
  const pattern = new RegExp(`\\.from\\((['"])${escapeRegExp(table)}\\1\\)[^;]*?\\.(?:insert|upsert)\\(`, 'g');
  return pattern.test(source);
}

function readsTable(source: string, table: string): boolean {
  return source.includes(`.from('${table}')`) || source.includes(`.from("${table}")`);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function renderDocumentHtml(document: LegalDocumentText): string {
  return renderToStaticMarkup(createElement(LegalDocumentBody, { document }));
}

/** タグを空白に置き換えた本文 (tests/business-info-legal-pages.test.ts の renderText と同じ考え方) */
function renderDocumentText(document: LegalDocumentText): string {
  return decodeEntities(stripAllTags(renderDocumentHtml(document), ' '));
}

function h3Texts(html: string): string[] {
  return [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => decodeEntities(stripAllTags(m[1])));
}

function allSections(document: LegalDocumentText): LegalSection[] {
  return document.chapters.flatMap((chapter) => chapter.sections);
}

function sectionById(document: LegalDocumentText, id: string): LegalSection {
  const section = allSections(document).find((s) => s.id === id);
  if (!section) throw new Error(`節 ${id} が無い`);
  return section;
}

function allBlocks(document: LegalDocumentText): LegalBlock[] {
  return [...(document.preamble ?? []), ...allSections(document).flatMap((s) => s.blocks)];
}

function firstBlock<K extends LegalBlock['kind']>(section: LegalSection, kind: K): Extract<LegalBlock, { kind: K }> {
  const block = section.blocks.find((b): b is Extract<LegalBlock, { kind: K }> => b.kind === kind);
  if (!block) throw new Error(`節 ${section.id} に ${kind} が無い`);
  return block;
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** src/app の page.tsx のパス (ルートグループ (x) を無視) */
function appRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const file of listFiles('src/app', ['page.tsx'])) {
    const segments = file
      .replace(/^src\/app\/?/, '')
      .replace(/\/?page\.tsx$/, '')
      .split('/')
      .filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment));
    routes.add(`/${segments.join('/')}`);
  }
  return routes;
}

const terms = termsText(TEST_CTX);
const privacy = privacyText(TEST_CTX);
const termsHtml = renderDocumentHtml(terms);
const privacyHtml = renderDocumentHtml(privacy);
const termsBody = renderDocumentText(terms);
const privacyBody = renderDocumentText(privacy);
const BOTH: { name: string; document: LegalDocumentText; body: string }[] = [
  { name: '利用規約', document: terms, body: termsBody },
  { name: 'プライバシーポリシー', document: privacy, body: privacyBody },
];

// ─── 段 A ─────────────────────────────────────────────────────────────────

describe('#1901 条の列挙と数', () => {
  it('T-1 利用規約の h3 のうち「第N条」で始まるものは TERMS_ARTICLE_HEADINGS と同じ順・同じ数で、TERMS_ARTICLE_COUNT と一致する', () => {
    const articles = h3Texts(termsHtml).filter((h) => /^第\d+条/.test(h));
    expect(articles).toEqual([...TERMS_ARTICLE_HEADINGS]);
    expect(TERMS_ARTICLE_HEADINGS).toHaveLength(TERMS_ARTICLE_COUNT);
  });

  it('T-2 プライバシーポリシーの h3 のうち「第N条」で始まるものは PRIVACY_SECTION_HEADINGS と同じ順・同じ数で、PRIVACY_SECTION_COUNT と一致する', () => {
    const articles = h3Texts(privacyHtml).filter((h) => /^第\d+条/.test(h));
    expect(articles).toEqual([...PRIVACY_SECTION_HEADINGS]);
    expect(PRIVACY_SECTION_HEADINGS).toHaveLength(PRIVACY_SECTION_COUNT);
  });
});

describe('#1901 LEGAL_FACTS は正本の値の写し', () => {
  it('T-3 LEGAL_FACTS の値は正本の定数と一致する (ADULT_AGE_YEARS・COPPA_AGE_YEARS・HIDDEN_CONTENT_RETENTION_DAYS・LOGIN_HISTORY_RETENTION_DAYS・SESSION_IDLE_EXPIRE_DAYS・DSR_RESPONSE_DUE_DAYS_DEFAULT)', () => {
    expect(LEGAL_FACTS.adultAgeYears).toBe(ADULT_AGE_YEARS);
    expect(LEGAL_FACTS.coppaAgeYears).toBe(COPPA_AGE_YEARS);
    expect(LEGAL_FACTS.hiddenContentRetentionDays).toBe(HIDDEN_CONTENT_RETENTION_DAYS);
    expect(LEGAL_FACTS.loginHistoryRetentionDays).toBe(LOGIN_HISTORY_RETENTION_DAYS);
    expect(LEGAL_FACTS.sessionIdleExpireDays).toBe(SESSION_IDLE_EXPIRE_DAYS);
    expect(LEGAL_FACTS.dsrResponseDueDaysDefault).toBe(DSR_RESPONSE_DUE_DAYS_DEFAULT);
  });

  it('T-4 LEGAL_FACTS の app_logs・送信待ちの保持は migration の文字列と一致する', () => {
    const appLogs = readRepo('supabase/migrations/20251126124224_create_meal_planner_tables.sql').toLowerCase();
    expect(appLogs).toContain(
      `delete from app_logs where created_at < now() - interval '${LEGAL_FACTS.appLogRetentionDays} days'`,
    );
    for (const file of ['supabase/migrations/20261016234000_email_outbox.sql', 'supabase/migrations/20261016237000_push_outbox.sql']) {
      const text = readRepo(file).toLowerCase();
      expect(text, file).toContain(`interval '${LEGAL_FACTS.outboxSentRetentionDays} days'`);
      expect(text, file).toContain(`interval '${LEGAL_FACTS.outboxDeadRetentionDays} days'`);
    }
  });

  it('T-5 LEGAL_FACTS のバックアップの保持は cross/17 §9.1 の表記と一致する', () => {
    const text = readRepo('docs/design/cross/17-backup-automation.md');
    const commas = (n: number) => n.toLocaleString('en-US');
    expect(text).toContain(`${commas(LEGAL_FACTS.backupDailyRetentionDays)} 日で削除`);
    expect(text).toContain(`${commas(LEGAL_FACTS.backupWeeklyRetentionDays)} 日で削除`);
    expect(text).toContain(`${commas(LEGAL_FACTS.backupAnnualRetentionDays)} 日で削除`);
    expect(text).toContain(`(${LEGAL_FACTS.backupAnnualRetentionYears} 年)`);
  });
});

describe('#1901 本文に書かないもの', () => {
  it.each(BOTH)('T-6 利用規約・プライバシーポリシーの本文に、未完成や予定を示す語が無い ($name)', ({ body }) => {
    for (const word of LEGAL_TEXT_PENDING_WORDS) expect(body, `「${word}」`).not.toContain(word);
    expect(body).not.toMatch(/coming soon/i);
  });

  it('T-7 PRIVACY_PROCESSORS の各行の evidence (file に needle) が実在し、needle と文面モジュールに外部のホスト名・URL が無い', () => {
    for (const { name, evidence } of PRIVACY_PROCESSORS) {
      expect(existsRepo(evidence.file), `${name}: ${evidence.file} が無い`).toBe(true);
      expect(readRepo(evidence.file), `${name}: ${evidence.file} に ${evidence.needle} が無い`).toContain(evidence.needle);
      expect(evidence.needle, name).not.toContain('://');
      expect(evidence.needle, name).not.toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i);
      expect(evidence.needle.length, name).toBeGreaterThanOrEqual(MIN_NEEDLE_LENGTH);
    }
    const legalSources = listFiles('src/lib/legal', ['.ts']);
    expect(legalSources).toHaveLength(4);
    for (const file of legalSources) {
      const text = readRepo(file);
      expect(text, file).not.toContain('https://');
      expect(text, file).not.toContain('exp.host');
    }
  });

  it('T-8 プライバシーポリシーの保存期間と請求の手順の数は LEGAL_FACTS から埋まっている', () => {
    const f = LEGAL_FACTS;
    for (const phrase of [
      `非表示にしてから ${f.hiddenContentRetentionDays} 日`,
      `失効してから ${f.loginHistoryRetentionDays} 日`,
      `${f.sessionIdleExpireDays} 日間操作が無い`,
      `${f.appLogRetentionDays} 日`,
      `送れたものは ${f.outboxSentRetentionDays} 日`,
      `送れなかったものは ${f.outboxDeadRetentionDays} 日`,
      `${f.dsrResponseDueDaysDefault} 日以内を目安`,
      `${f.backupDailyRetentionDays} 日、週次のものは ${f.backupWeeklyRetentionDays} 日、年次のものは ${f.backupAnnualRetentionDays} 日（${f.backupAnnualRetentionYears} 年）`,
    ]) {
      expect(privacyBody, phrase).toContain(phrase);
    }
  });

  it('T-9 利用規約第9条に cross/08 §8.1 と同じ医療免責の文と、救急（119）の案内がある', () => {
    expect(readRepo('docs/design/cross/08-legal-compliance.md')).toContain(TERMS_MEDICAL_DISCLAIMER);
    const article9 = renderDocumentText({ ...terms, chapters: [{ id: 'x', title: null, sections: [sectionById(terms, 'terms-9')] }] });
    expect(article9).toContain(TERMS_MEDICAL_DISCLAIMER);
    expect(article9).toContain('救急（119）');
  });

  it('T-10 利用規約第14条に AI 生成物の 3 項 (ユーザー帰属・匿名化した集計利用・CC0 相当) がある', () => {
    expect(termsBody).toContain('個人利用の範囲でユーザーに帰属');
    expect(termsBody).toContain('匿名化した形で');
    expect(termsBody).toContain('CC0 相当');
  });

  it.each(BOTH)('T-11 文面モジュールは AI 事業者の名前を直接書かない (ctx の一覧が空なら本文に出ない) ($name)', ({ body }) => {
    for (const name of ['OpenAI', 'Perplexity', 'xAI', 'AI/ML API']) expect(body, name).not.toContain(name);
  });

  it.each(BOTH)('T-13 文面モジュールは事業者名の形 (株式会社〇〇・〇〇 Inc) を直接書かない ($name)', ({ body }) => {
    expect(body).not.toContain('株式会社');
    expect(body).not.toMatch(/\b[A-Za-z]+,? Inc\b/);
  });

  it('T-14 links ブロックの href はすべて実在する公開のページか請求の画面を指す', () => {
    const routes = appRoutes();
    const hrefs = new Set(
      BOTH.flatMap(({ document }) => allBlocks(document))
        .flatMap((block) => (block.kind === 'links' ? block.items.map((item) => item.href) : [])),
    );
    expect(hrefs.size).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(ALLOWED_LINK_HREFS, href).toContain(href);
      expect(routes.has(href), `${href} の page.tsx が無い`).toBe(true);
    }
  });

  it('T-15 section の id は一意で、terms- / privacy- で始まる', () => {
    const termsIds = allSections(terms).map((s) => s.id);
    const privacyIds = allSections(privacy).map((s) => s.id);
    const all = [...termsIds, ...privacyIds];
    expect(new Set(all).size).toBe(all.length);
    for (const id of termsIds) expect(id).toMatch(/^terms-/);
    for (const id of privacyIds) expect(id).toMatch(/^privacy-/);
  });

  it('T-16 プライバシーポリシー第1条の表と両文書の窓口は、ctx の事業者の情報を出す', () => {
    const table = firstBlock(sectionById(privacy, 'privacy-1'), 'table');
    expect(table.rows).toEqual([
      ['事業者の名称', 'TESTCO'],
      ['所在地', 'TESTADDRESS'],
      ['代表者', 'TESTREP'],
      ['電話番号', 'TESTPHONE。ご請求は、contact@example.com またはお問い合わせフォームからお願いします。'],
      ['メールアドレス', 'contact@example.com'],
      ['営業時間', 'TESTHOURS'],
    ]);
    // 電話番号の行は、/legal・/company の電話番号の欄 (PhoneOnRequest) と同じ組み立て (tests/business-info-legal-pages.test.ts の期待値)
    expect(table.rows[3][1]).toBe(`${TEST_CTX.phoneDisclosure}。ご請求は、${TEST_CTX.businessEmail} またはお問い合わせフォームからお願いします。`);
    for (const { name, document } of BOTH) {
      const contacts = allBlocks(document).filter((b): b is Extract<LegalBlock, { kind: 'contact' }> => b.kind === 'contact');
      expect(contacts.length, name).toBeGreaterThanOrEqual(1);
      for (const contact of contacts) expect(contact.email, name).toBe(TEST_CTX.businessEmail);
    }
  });

  it.each(BOTH)('T-19 /terms /privacy の本文に効果・成果の言い回しが無い ($name)', ({ body }) => {
    for (const word of LEGAL_TEXT_FORBIDDEN_CLAIMS) expect(body, word).not.toContain(word);
  });
});

describe('#1901 プライバシーポリシーの委託先・送り先・端末の機能', () => {
  it('T-24 プライバシーポリシー第7条の表の行数は PRIVACY_PROCESSORS.length と同じ', () => {
    const table = firstBlock(sectionById(privacy, 'privacy-7'), 'table');
    expect(table.rows).toHaveLength(PRIVACY_PROCESSORS.length);
    expect(table.rows.map((row) => row[0])).toEqual(PRIVACY_PROCESSORS.map((p) => p.name));
  });

  it('T-25 プライバシーポリシーに、仮名加工情報・匿名加工情報を作成しない旨、AI 事業者への提供の記録、端末の機能の文がある', () => {
    for (const phrase of [
      '仮名加工情報および匿名加工情報',
      '提供の記録として、同意の記録',
      'カメラ',
      '写真ライブラリ',
      '位置情報、連絡先、マイクの音声を取得しません',
      new URL(HOLIDAYS_API_ORIGIN).host,
    ]) {
      expect(privacyBody, phrase).toContain(phrase);
    }
  });

  it('T-26 apps/mobile/app.json の端末の権限の宣言は、既知の一覧に含まれる (新しい権限を足したら第3条の端末の機能の文を直す)', () => {
    const appJson = JSON.parse(readRepo('apps/mobile/app.json')) as {
      expo: { ios?: { infoPlist?: Record<string, unknown> }; android?: { permissions?: string[] } };
    };
    const usageKeys = Object.keys(appJson.expo.ios?.infoPlist ?? {}).filter((key) => key.endsWith('UsageDescription'));
    for (const key of usageKeys) expect(KNOWN_IOS_USAGE_DESCRIPTIONS, key).toContain(key);
    for (const permission of appJson.expo.android?.permissions ?? []) expect(KNOWN_ANDROID_PERMISSIONS, permission).toContain(permission);
  });

  it('T-27 アプリの更新の取得 (EAS Update) は無効のまま (有効にしたらプライバシーポリシー第10条に送り先の行を足して版を上げる)', () => {
    // 根拠: 設計書 cross/20 F-15 (アプリの更新の取得は外部送信の送り先になる)
    const appJson = JSON.parse(readRepo('apps/mobile/app.json')) as {
      expo: { updates?: { enabled?: boolean; checkAutomatically?: string } };
    };
    expect(appJson.expo.updates?.enabled).toBe(false);
    expect(appJson.expo.updates?.checkAutomatically).toBe('NEVER');
    const files = listFiles('apps/mobile/app', ['.ts', '.tsx']).concat(listFiles('apps/mobile/src', ['.ts', '.tsx']));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readRepo(file);
      expect(text, file).not.toContain("from 'expo-updates'");
      expect(text, file).not.toContain('from "expo-updates"');
    }
  });

  it('T-29 CSP の外部の許可先 (script-src・frame-src・img-src・connect-src) は、プライバシーポリシー第10条の表に行がある送り先か、端末から送らない理由を持つものだけ', () => {
    const directives = cspDirectivesOf(
      buildContentSecurityPolicy({ nonce: 'n', isDev: false, supabaseUrl: 'https://example.supabase.co' }),
    );
    const external = new Set(
      CSP_DISCLOSED_DIRECTIVES.flatMap((name) => directives.get(name) ?? []).filter(
        (source) => !CSP_NON_EXTERNAL_SOURCE_PATTERN.test(source),
      ),
    );
    expect([...external].sort()).toEqual(Object.keys(CSP_EXTERNAL_ORIGIN_DISCLOSURE).sort());
    const destinations = firstBlock(sectionById(privacy, 'privacy-10'), 'table').rows.map((row) => row[0]);
    for (const [origin, word] of Object.entries(CSP_EXTERNAL_ORIGIN_DISCLOSURE)) {
      if (word !== null) {
        expect(destinations.some((cell) => cell.includes(word)), `${origin} → ${word}`).toBe(true);
        continue;
      }
      const users = listFiles('src', ['.ts', '.tsx'])
        .filter((file) => !file.includes('__tests__') && !TEST_FILE_PATTERN.test(file) && file !== 'src/lib/security/csp.ts')
        .filter((file) => readRepo(file).includes(origin));
      expect(users.length, origin).toBeGreaterThan(0);
      for (const file of users) {
        const text = readRepo(file);
        expect(text, file).toMatch(/from ['"]next\/image['"]/);
        expect(text, file).not.toContain('unoptimized');
      }
      for (const file of listFiles('apps/mobile', ['.ts', '.tsx'])) {
        expect(readRepo(file), file).not.toContain(origin);
      }
    }
  });

  it('T-30 IP アドレス・User-Agent を持つ表は、プライバシーポリシー第3条に載せた表か、載せない理由を持つ表のどちらかに入っている', () => {
    const lines = readRepo('packages/shared/src/database.types.ts').split('\n');
    const start = lines.indexOf('    Tables: {');
    const end = lines.indexOf('    Views: {', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const tables = new Set<string>();
    let current: string | null = null;
    let inRow = false;
    for (const line of lines.slice(start + 1, end)) {
      const table = /^ {6}([a-z0-9_]+): \{$/.exec(line);
      if (table) {
        current = table[1];
        inRow = false;
        continue;
      }
      if (line === '        Row: {') {
        inRow = true;
        continue;
      }
      if (inRow && line === '        }') {
        inRow = false;
        continue;
      }
      if (inRow && current) {
        const column = /^ {10}([a-z0-9_]+)\??:/.exec(line);
        if (column && IP_UA_COLUMNS.includes(column[1])) tables.add(current);
      }
    }
    expect([...tables].sort()).toEqual([...Object.keys(DISCLOSED_IP_UA_TABLES), ...Object.keys(EXCLUDED_IP_UA_TABLES)].sort());
    for (const [table, phrase] of Object.entries(DISCLOSED_IP_UA_TABLES)) expect(privacyBody, table).toContain(phrase);
    const code = listCodeFiles(['src', 'supabase/functions']);
    for (const [table, reason] of Object.entries(EXCLUDED_IP_UA_TABLES)) {
      if (reason !== 'no_writer') continue;
      for (const file of code) expect(readsTable(readRepo(file), table), `${file} が ${table} を使う`).toBe(false);
      expect(migrationsInsertingInto(table), table).toEqual([]);
    }
  });

  it('T-31 プライバシーポリシー第11条の多要素認証の文は MFA_REQUIRED_ROLES に当たる (大きな権限を持つ担当者の仕組みと書き、運営担当者の全員とは書かない)', () => {
    const roles: readonly string[] = MFA_REQUIRED_ROLES;
    expect(roles).toContain('admin');
    expect(roles).toContain('super_admin');
    expect(roles).not.toContain('support');
    expect(privacyBody).toContain('大きな権限を持つ運営担当者のログインに多要素認証を用いる仕組みを設けています');
    expect(privacyBody).not.toContain('運営担当者のログインには多要素認証を求めています');
  });

  it('T-32 組織の管理者の画面が読む項目は、プライバシーポリシー第9条に書いた項目を超えず、承諾済みの招待は宛先のメールアドレスとともに一覧に残る', () => {
    expect(readRepo('src/app/(org)/org/members/page.tsx')).toContain(".select('id, nickname, org_role, joined_org_at')");
    const orgInvites = readRepo('src/app/api/org/invites/route.ts');
    const selected = /\.select\(\s*`([^`]*)`/.exec(orgInvites);
    expect(selected, 'org の招待の GET の select').not.toBeNull();
    const columns = (selected?.[1] ?? '').split(/[\s,]+/).filter((c) => c !== '');
    expect(new Set(columns)).toEqual(
      // 役割は invited_role (create_org_invite が書く列)・状態は status (取り消し・拒否を一覧に出す)。旧い role 列は読まない
      new Set(['id', 'email', 'invited_role', 'status', 'department_id', 'token', 'expires_at', 'accepted_at', 'created_at', 'departments(name)']),
    );
    // src/app/(main)/org は管理画面の枠の外に置いた組織の画面 (オーナーの譲渡の承諾の画面。#2068)
    for (const file of listCodeFiles(['src/app/(org)', 'src/app/(main)/org', 'src/app/api/org'])) {
      const text = readRepo(file);
      expect(text, file).not.toContain('last_sign_in_at');
      expect(text, file).not.toContain('employee_');
    }
    for (const file of ['src/app/api/org/invites/route.ts', 'src/app/api/family/invites/route.ts']) {
      const text = readRepo(file);
      const start = text.indexOf('export async function GET');
      expect(start, file).toBeGreaterThan(-1);
      const next = text.indexOf('export async function', start + 1);
      const get = text.slice(start, next === -1 ? undefined : next);
      for (const filter of [".is('accepted_at'", ".not('accepted_at'", ".eq('status'", ".neq('status'", ".in('status'"]) {
        expect(get, `${file} の GET に ${filter}`).not.toContain(filter);
      }
    }
    expect(latestFunctionDefinition('accept_org_invite').body).toContain('INVITE_EMAIL_MISMATCH');
    expect(latestFunctionDefinition('accept_family_invite').body).toContain('INVITE_EMAIL_MISMATCH');
    expect(latestFunctionDefinition('accept_child_promotion').body).toContain('PROMOTION_EMAIL_MISMATCH');
    expect(privacyBody).toContain('組織の管理者に表示されるのは、メンバーの表示名、組織内の役割、参加した日');
    expect(privacyBody).toContain('参加の時点で登録していたメールアドレスは、承諾した招待の宛先として残り');
  });

  it('T-33 利用規約・プライバシーポリシーの有料プランの条文は billing/03 §11 のとおりで、有料の語は有料の条文の節にだけ出て、委託先の表に決済の事業者と RevenueCat がある', () => {
    expect(firstBlock(sectionById(terms, 'terms-10'), 'ol').items).toEqual(PAID_TERMS_10_ITEMS);

    const units = [...legalTextUnits(terms), ...legalTextUnits(privacy)];
    const paidUnits = units.filter((unit) => LEGAL_TEXT_PAID_TERMS.some((word) => unit.text.includes(word)));
    expect(paidUnits.length, '有料の語を含む単位が無い').toBeGreaterThan(0);
    for (const unit of paidUnits) expect(PAID_TERMS_SECTIONS, `${unit.section}: ${unit.text}`).toContain(unit.section);

    const names = PRIVACY_PROCESSORS.map((p) => p.name);
    for (const name of ['Stripe', 'RevenueCat']) expect(names).toContain(name);
    expect(names).not.toContain('Apple');
    expect(TERMS_ARTICLE_HEADINGS[9]).toBe('第10条（料金）');
  });

  it('T-34 利用者に紐づく表は、すべてプライバシーポリシー第3条の行か、載せない理由のどちらかに入っている', () => {
    const exportTables = new Set([...ACCOUNT_EXPORT_TABLES.map((spec) => spec.table), ...Object.keys(ACCOUNT_EXPORT_EXCLUDED)]);
    const listed = [...Object.keys(PRIVACY_DATA_TABLES), ...Object.keys(PRIVACY_DATA_EXCLUDED)];
    expect(new Set(listed).size, '2 つの定数のキーが重なる').toBe(listed.length);
    expect([...exportTables].sort()).toEqual([...listed].sort());

    const categories = firstBlock(sectionById(privacy, 'privacy-3'), 'table').rows.map((row) => row[0]);
    for (const [table, category] of Object.entries(PRIVACY_DATA_TABLES)) expect(categories, table).toContain(category);
    const used = new Set(Object.values(PRIVACY_DATA_TABLES));
    for (const category of categories) {
      if (category === 'Cookie 等') continue;
      expect(used.has(category), `第3条の行「${category}」に当たる表が無い`).toBe(true);
    }

    const noWriterCode = listCodeFiles(['src', 'supabase/functions', 'lib', 'packages/shared/src', 'apps/mobile/src', 'apps/mobile/app']).map(
      (file) => ({ file, text: readRepo(file) }),
    );
    for (const [table, reason] of Object.entries(PRIVACY_DATA_EXCLUDED)) {
      if (reason === 'no_writer') {
        const writers = noWriterCode.filter(({ text }) => writesTable(text, table)).map(({ file }) => file);
        expect(writers, `${table} に書くコード`).toEqual([]);
        expect(migrationsInsertingInto(table), `${table} に INSERT する migration`).toEqual([]);
      }
    }
  });

  it('T-36 AI 相談が AI 事業者へ送る文のために読む表は、すべてプライバシーポリシー第6条の送る情報の項目に対応している', () => {
    const source = readRepo('src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts');
    const tables = new Set([...source.matchAll(/\.from\((['"])([a-z0-9_]+)\1\)/g)].map((m) => m[2]));
    expect([...tables].sort()).toEqual(Object.keys(AI_CONTEXT_TABLES).sort());
    const items = firstBlock(sectionById(privacy, 'privacy-6'), 'ul').items;
    for (const [table, word] of Object.entries(AI_CONTEXT_TABLES)) {
      expect(items.some((item) => item.includes(word)), `${table} → ${word}`).toBe(true);
    }
  });
});

describe('#1901 約束の文は実装に合わせてある', () => {
  it('T-28 利用規約・プライバシーポリシーの約束の文は実装に合わせてある (責任の範囲・同意の前にできること・施行日の前のお知らせ・遅滞なく・写真と健康の見え方・AI に送る種類・送信停止の記録・ログの保存期間・ログインの記録の IP と国)', () => {
    for (const phrase of [
      '本規約と個別規定の内容が異なるときは、本規約が優先します',
      // #1901 Q-23: 同意の前でも、本人が退会とデータの書き出しを行える (同意画面の下の /legal-consent/account)
      'ただし、個人情報の開示・訂正・利用停止・消去などの請求、お問い合わせ、退会とデータの書き出しは、同意の前でも行うことができます',
      '改めて同意するまでの間も、退会とデータの書き出しを行うことができます',
      // #1917: 代表者・オーナーは、譲渡するか解散するまで退会できない (docs/design/family/11-self-dissolve.md §18.1)
      '譲渡するか、組織を解散するまで、退会できません',
      '譲渡するか、組織または家族グループを解散するまで、退会できません',
      '施行日の前に本サービスのお知らせに掲載',
      '本サービスは、無料で利用できます',
    ]) {
      expect(termsBody, phrase).toContain(phrase);
    }
    expect(countOccurrences(termsBody, '第21条（損害賠償と責任の制限）に定める範囲で責任を負います')).toBe(2);
    for (const phrase of [
      '個別規定が優先します',
      '重大な過失がある場合を除き、責任を負いません',
      'アカウントと保存されたデータを削除します',
      'お問い合わせから削除を依頼',
      '家族グループの代表者と管理者',
      '代わりに記録',
      '家族グループを解散する必要があります',
      'いつでも退会できます',
      '保護者に届く案内',
      // #1901 Q-23: 同意の前の退会に、改定後の内容への同意を求めない
      '同意したうえで、退会',
      '退会のみを行うことができます',
      '譲渡するまで、退会できません',
    ]) {
      expect(termsBody, phrase).not.toContain(phrase);
    }
    for (const phrase of [
      '遅滞なく対応します',
      '家族グループのメンバーにも組織の管理者にも表示されません',
      '持病、服薬、妊娠・授乳の状況',
      'メールアドレスのまま残します',
      'ブラウザのセキュリティ違反の報告を含みます',
      'IP アドレスとそのネットワークの範囲、通信から判定した国',
      '体重計・体組成計の写真',
      '運営担当者が利用者のデータを変更する操作を記録しています',
      // #1901 Q-23
      '改めて同意するまでの間も、退会と書き出しを行うことができます',
    ]) {
      expect(privacyBody, phrase).toContain(phrase);
    }
    for (const phrase of [
      '氏名は送りません',
      '個人情報の取扱いの責任者',
      'ネットワーク単位にして保存',
      '運営担当者の操作は記録します',
      '代わりに記録',
      '回まで送り直せます',
      'いつでも退会できます',
    ]) {
      expect(privacyBody, phrase).not.toContain(phrase);
    }

    // #1901 R1: 設計書 §9.4 の 2 (改定の予告) でお知らせに載せる中身も、利用規約第24条2項 (同意の前でも退会と書き出しができる) と食い違わない
    const announcementSteps = readRepo(DESIGN_DOC)
      .split('\n')
      .filter((line) => line.startsWith('2. ') && line.includes('改定の予告を載せる'));
    expect(announcementSteps, '§9.4 の 2 の行').toHaveLength(1);
    expect(termsBody).toContain('退会とデータの書き出しは、同意の前でも行うことができます');
    expect(announcementSteps[0]).toContain('同意の前でも開示等の請求・お問い合わせ・退会とデータの書き出し');
    expect(announcementSteps[0]).not.toContain('同意したうえで');
  });

  it('T-37 家族の役割は代表者・大人・子どもの 3 つで、本人のアカウントをつないだ未成年者は大人になる (利用規約第11条の「代表者」とプライバシーポリシー第9条の「家族グループのメンバー」の前提)', () => {
    const base = readRepo('supabase/migrations/20251126124224_create_meal_planner_tables.sql');
    const start = base.indexOf('CREATE TYPE "public"."family_role_enum" AS ENUM (');
    expect(start).toBeGreaterThan(-1);
    const end = base.indexOf(');', start);
    const values = [...base.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values).toEqual(['representative', 'adult', 'child']);
    for (const file of listMigrations()) {
      for (const statement of readRepo(file).split(';')) {
        const added = /ALTER TYPE/i.test(statement) && statement.includes('family_role_enum') && /ADD VALUE/i.test(statement);
        expect(added, `${file} が family_role_enum に値を足す`).toBe(false);
      }
    }
    expect(latestFunctionDefinition('accept_child_promotion').body).toContain("role = 'adult'");
    expect(termsBody).not.toContain('家族グループの代表者と管理者');
  });

  it('T-38 運営の操作の記録の文 (利用者のデータを変更する操作) は、記録の見張りに当たる', () => {
    const watcher = readRepo('tests/admin-mutation-audit-coverage-1571.test.ts');
    expect(watcher).toContain("'src/app/api/admin/moderation/[type]/[id]/route.ts POST': 'audited'");
    expect(watcher).toContain("'src/app/api/admin/users/[id]/freeze/route.ts POST': 'audited'");
    expect(privacyBody).toContain('運営担当者が利用者のデータを変更する操作を記録しています');
    expect(privacyBody).not.toContain('運営担当者の操作は記録します');
    expect(privacyBody).not.toContain('運営担当者の操作を記録しています');
  });

  it('T-39 解散した家族グループの削除の日数と、保護者の同意の記録を持つグループを残すことは、削除のジョブの関数と一致する', () => {
    const days = LEGAL_FACTS.dissolvedFamilyGroupRetentionDays;
    const purge = latestFunctionDefinition('purge_dissolved_family_groups').body;
    expect(purge).toContain(`interval '${days} days'`);
    expect(purge).toContain('NOT EXISTS (SELECT 1 FROM public.parental_consents');
    expect(privacyBody).toContain(`解散から ${days} 日が経過すると削除します`);
    expect(privacyBody).toContain('保護者の同意の記録があるグループは、同意の根拠として、削除せずに残します');
    expect(privacyBody).toContain('家族グループが解散したときも残します');
    expect(termsBody).toContain('解散した家族グループの情報の扱いは、プライバシーポリシー第12条のとおりです');
  });

  it('T-41 健康診断・血液検査・体重計の写真を保存しない文は、読み取りの処理が Storage に書かないことに当たる', () => {
    for (const file of PHOTO_READ_ONLY_SOURCES) {
      const text = readRepo(file);
      expect(text, file).not.toContain('.upload(');
      expect(text, file).not.toContain('storage.from(');
    }
    const holders = listCodeFiles(['src', 'apps/mobile/app', 'apps/mobile/src', 'supabase/functions'])
      .filter((file) => path.posix.basename(file) !== 'database.types.ts')
      .filter((file) => readRepo(file).includes('report_image_url'));
    expect(holders).toEqual(['src/lib/account-deletion-storage.ts']);
    expect(readRepo('src/app/(main)/meals/new/page.tsx')).not.toContain('image_url');
    expect(readRepo('src/app/(main)/health/checkups/new/page.tsx')).toContain('記録には保存されません');
    expect(privacyBody).toContain('数値の読み取りに使うだけで、本サービスには保存しません');
    expect(privacyBody).not.toContain('撮った写真は、第4条の目的で本サービスに保存し');
  });

  it('T-42 公開の状態のユーザーコンテンツ (レシピ) は未ログインの人にも読める実装に、利用規約第13条が合っている', () => {
    const baseFile = 'supabase/migrations/20251126124224_create_meal_planner_tables.sql';
    expect(readRepo(baseFile)).toContain(
      'GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipes" TO "anon"',
    );
    const later = listMigrations().filter((file) => file > baseFile);
    for (const file of later) {
      const revokes = readRepo(file).match(/REVOKE[^;]*ON\s+(?:TABLE\s+)?(?:"?public"?\.)?"?recipes"?\s+FROM[^;]*\banon\b[^;]*;/gi);
      expect(revokes, `${file} が recipes の権限を anon から外す`).toBeNull();
    }
    let lastPolicy: string | null = null;
    for (const file of listMigrations()) {
      const matches = readRepo(file).match(/(?:CREATE|ALTER) POLICY\s+"Users can view public recipes"[^;]*;/g);
      if (matches) lastPolicy = matches[matches.length - 1];
    }
    expect(lastPolicy).not.toBeNull();
    expect(lastPolicy).toContain('is_public = true');
    expect(lastPolicy).not.toContain('TO authenticated');
    expect(readRepo('src/app/api/recipes/route.ts')).toContain("dbQuery.eq('is_public', true)");
    expect(termsBody).toContain('ユーザーが公開の状態にしたユーザーコンテンツは、ログインしていない方を含め、誰でも閲覧できる状態になります');
    for (const phrase of ['他のユーザーに表示されます', 'レシピの作成、公開', '「公開」に設定']) expect(termsBody, phrase).not.toContain(phrase);
  });
});

describe('#1901 本文の主張と画面の名前', () => {
  it('T-35 利用規約とプライバシーポリシーの本文の主張 (1 文と表の 1 行) は、主張の表 LEGAL_CLAIMS と 1 対 1 で対応し、根拠を持つ', () => {
    const units = [...legalTextUnits(terms), ...legalTextUnits(privacy)];
    expect(LEGAL_CLAIMS).toHaveLength(LEGAL_CLAIM_COUNT);
    const unmatched = units.filter(
      (unit) => LEGAL_CLAIMS.filter((claim) => claim.section === unit.section && unit.text.includes(claim.fragment)).length !== 1,
    );
    expect(unmatched.map((u) => `${u.section}: ${u.text}`), '表の行とちょうど 1 対 1 で対応しない単位').toEqual([]);
    expect(units).toHaveLength(LEGAL_CLAIM_COUNT);

    const ids = LEGAL_CLAIMS.map((claim) => claim.id);
    expect(new Set(ids).size).toBe(ids.length);
    const design = readRepo(DESIGN_DOC);
    const pathPattern = /(?:\.github|src|lib|supabase|packages|apps|tests|docs)\/[\w./()[\]@-]+?\.(?:tsx|ts|sql|md|json|yml|mjs|js)(?!\w)/g;
    for (const claim of LEGAL_CLAIMS) {
      expect(claim.id, claim.id).toMatch(new RegExp(`^${escapeRegExp(claim.section)}#\\d+$`));
      const matching = units.filter((unit) => unit.section === claim.section && unit.text.includes(claim.fragment));
      expect(matching, `${claim.id} (${claim.fragment})`).toHaveLength(1);
      expect(matching[0]?.text.length, `${claim.id} の字数`).toBe(claim.chars);
      if (claim.basis === 'product' || claim.basis === 'process') expect(claim.evidence.trim(), claim.id).not.toBe('');
      for (const ref of claim.evidence.match(/\b[FP]-\d+\b/g) ?? []) {
        expect(design, `${claim.id}: ${ref} の行が設計書に無い`).toContain(`| ${ref} |`);
      }
      for (const file of claim.evidence.match(pathPattern) ?? []) {
        expect(existsRepo(file), `${claim.id}: ${file} が無い`).toBe(true);
      }
    }
  });

  it('T-40 本文は画面の名前の引用と画面の道順を書かない', () => {
    const texts = [
      ...legalTextUnits(terms).map((u) => u.text),
      ...legalTextUnits(privacy).map((u) => u.text),
      ...BOTH.flatMap(({ document }) => allBlocks(document)).flatMap((block) =>
        block.kind === 'links' ? block.items.map((item) => item.label) : [],
      ),
    ];
    for (const text of texts) {
      for (const pattern of SCREEN_REFERENCE_PATTERNS) expect(text, `${pattern}`).not.toMatch(pattern);
      for (const name of SCREEN_NAMES) expect(text, name).not.toContain(name);
    }
  });
});

// ─── 段 B (ページ・版・旧版の控え) ─────────────────────────────────────────

function renderPage(Page: ComponentType): string {
  return renderToStaticMarkup(createElement(Page));
}

describe('#1901 ページ・版・旧版の控え', () => {
  it('T-12 AI 事業者の一覧は ctx の順で data-testid="privacy-ai-providers" の ul に「名前（国）：使い道」で出る。利用規約には出ない', () => {
    const html = renderPage(PrivacyPage);
    const list = /<ul[^>]*data-testid="privacy-ai-providers"[^>]*>([\s\S]*?)<\/ul>/.exec(html);
    expect(list, '送信先の一覧が無い').not.toBeNull();
    const items = [...(list?.[1] ?? '').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => decodeEntities(stripAllTags(m[1])));
    expect(items).toEqual(
      AI_CONSENT_PROVIDERS.map((id) => {
        const info = AI_CONSENT_PROVIDER_INFO[id];
        return `${info.name}（${info.country}）：${info.usage}`;
      }),
    );
    expect(renderPage(TermsPage)).not.toContain('privacy-ai-providers');
  });

  it('T-17 LEGAL_DOCUMENTS の 2 文書の版と施行日はそれぞれ同じで、版は仮置きの v2025.1 ではない', () => {
    expect(LEGAL_DOCUMENTS.terms_of_service.version).not.toBe('v2025.1');
    expect(LEGAL_DOCUMENTS.privacy_policy.version).toBe(LEGAL_DOCUMENTS.terms_of_service.version);
    expect(LEGAL_DOCUMENTS.privacy_policy.effectiveDate).toBe(LEGAL_DOCUMENTS.terms_of_service.effectiveDate);
  });

  it('T-18 /terms の h3 の数は TERMS_ARTICLE_COUNT + 1 (附則)、/privacy は PRIVACY_SECTION_COUNT + 1', () => {
    expect(h3Texts(renderPage(TermsPage))).toHaveLength(TERMS_ARTICLE_COUNT + 1);
    expect(h3Texts(renderPage(PrivacyPage))).toHaveLength(PRIVACY_SECTION_COUNT + 1);
  });

  it('T-20 docs/legal/archive/v2025.1/terms.md と privacy.md があり、旧版の条の見出しを含む', () => {
    const oldTerms = readRepo('docs/legal/archive/v2025.1/terms.md');
    for (const heading of [
      '第1条（適用）',
      '第2条（利用登録）',
      '第3条（ユーザーIDおよびパスワードの管理）',
      '第4条（AI解析とデータ利用）',
      '第5条（禁止事項）',
      '第6条（本サービスの提供の停止等）',
      '第7条（免責事項）',
      '第8条（サービス内容の変更等）',
      '第9条（準拠法・裁判管轄）',
    ]) {
      expect(oldTerms, heading).toContain(heading);
    }
    const oldPrivacy = readRepo('docs/legal/archive/v2025.1/privacy.md');
    for (const heading of [
      '第1条（個人情報）',
      '第2条（個人情報の収集方法）',
      '第3条（個人情報を収集・利用する目的）',
      '第4条（利用目的の変更）',
      '第5条（個人情報の第三者提供）',
      '第6条（個人情報の開示・訂正・削除）',
      '第7条（お問い合わせ窓口）',
    ]) {
      expect(oldPrivacy, heading).toContain(heading);
    }
    for (const text of [oldTerms, oldPrivacy]) {
      expect(text).toContain('v2025.1');
      expect(text).toContain('2025-01-01');
    }
  });
});
