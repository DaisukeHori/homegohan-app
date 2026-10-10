/**
 * 外国の AI 事業者への提供の同意: 事業者の表示内容・文面 (サーバーとブラウザの両方から使う)
 *
 * T15 (#1154 / #1133 / #1169)。このファイルはサーバー専用の import (next/headers など) を持たない。
 * 同意画面 (src/components/consent/AiDataConsentModal.tsx) と設定ページ (src/app/(main)/settings/ai-consent/page.tsx) は、
 * ここを import する。DB を読み書きする関数は src/lib/ai/consent.ts (サーバー専用) にある。
 *
 * 事業者の一覧 (AI_CONSENT_PROVIDERS)・版 (AI_CONSENT_VERSION)・状態の型・判定 (summarizeAiConsent / runAiConsentCheck)・
 * 止めたときのエラーコード (AI_CONSENT_REQUIRED_CODE) は、Edge Functions と共用の
 * supabase/functions/_shared/ai-consent.ts にある。ここはそれを再エクスポートする (定義を 2 か所に持たない)。
 *
 * 【未同意なら AI へ送らない】
 * 有効な同意 (全事業者・現行の版) が無い利用者のデータは、サーバーが外国の AI 事業者へ送る手前で止める
 * (403 + code: AI_CONSENT_REQUIRED)。画面はこのエラーを受けたら同意画面へ案内する。
 *
 * ┌─ 文面は仮 (DRAFT) ─────────────────────────────────────────────────────────────┐
 * │ AI_CONSENT_COPY の文面は、弁護士の確認が済むまで仮のもの。                         │
 * │ 確認後に文面を差し替えるときは、必ず AI_CONSENT_VERSION も新しい版に変えること。   │
 * │ 版を変えると、古い版に同意した人は未同意に戻り、AI 機能の前にもう一度同意画面が出る。│
 * │ (同意の記録には、同意したときの版が入る: external_data_consents.policy_version)     │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * 弁護士に確認してもらう点 (文面を確定するときの宿題):
 *   - 事業者の正式名称・所在国・所在地 (いまは画面に出す呼び名と国だけ)。
 *     AI/ML API (api.aimlapi.com) の運営会社は利用規約に AIMLAPI OÜ とあり、所在国はエストニアと読めるが、確認が要る。
 *     AI/ML API は、受け取った文章を Voyage AI のモデル (voyage-multilingual-2) で数値化する中継の事業者である
 *   - 各事業者での保存期間と、送った内容を事業者の AI の学習に使うかどうか (いまは「事業者ごとに異なる」としか書いていない)
 *   - 提供する情報の範囲 (写真・数値・相談文のほか、献立の作成に使う好み・アレルギー・健康目標を含めるか)
 *   - 画面を開くと自動で AI に送る処理 (ホームの栄養アドバイス、週間献立の栄養士コメントなど) は、同意が無ければ送らず、
 *     同意画面は出さずに案内の一文 (automaticLockedNote) だけを出す。この扱いでよいか
 *   - Anthropic は、現在 AI の呼び出しに使っていないので一覧に入れていない (DB の CHECK には値が残っている)
 */

export {
  AI_CONSENT_PROVIDERS,
  AI_CONSENT_VERSION,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_REQUIRED_STATUS,
  AI_CONSENT_REQUIRED_MESSAGE,
  AI_CONSENT_CHECK_FAILED_CODE,
  AI_CONSENT_CHECK_FAILED_STATUS,
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  isAiConsentRequiredBody,
  aiConsentReasonOfStoredError,
  aiSkippedReasonOf,
  aiSummarySkippedNote,
  summarizeAiConsent,
  AI_CONSENT_SETTINGS_ENTRY_TITLE,
  AI_CONSENT_AUTOMATIC_LOCKED_NOTE,
  AI_CONSENT_SKIPPED_NOTE,
  AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE,
  type AiSkippedReason,
  type AiConsentProvider,
  type AiConsentProviderState,
  type AiConsentProviderStatus,
  type AiConsentStatus,
  type AiConsentRow,
} from '../../../supabase/functions/_shared/ai-consent';

import {
  AI_CONSENT_AUTOMATIC_LOCKED_NOTE,
  AI_CONSENT_SETTINGS_ENTRY_TITLE,
  type AiConsentProvider,
} from '../../../supabase/functions/_shared/ai-consent';

/** 設定ページ (同意の確認・撤回) の URL */
export const AI_CONSENT_SETTINGS_PATH = '/settings/ai-consent';

export interface AiConsentProviderInfo {
  id: AiConsentProvider;
  /** 画面に出す名前 */
  name: string;
  /** 事業者の所在国 */
  country: string;
  /** その事業者の AI をどの機能で使うか (画面に出す短い説明) */
  usage: string;
}

/**
 * 事業者ごとの表示内容。使い道は 2026-10 時点のコードの実態に合わせた概要
 * (送信先の一覧は supabase/functions/_shared/ai-consent.ts の AI_CONSENT_PROVIDERS のコメントを参照)。
 */
export const AI_CONSENT_PROVIDER_INFO: Record<AiConsentProvider, AiConsentProviderInfo> = {
  xai: {
    id: 'xai',
    name: 'xAI',
    country: 'アメリカ合衆国',
    usage: 'AI 相談への回答、健康診断・血液検査の結果へのコメント、献立・買い物リストの作成、栄養の計算',
  },
  google: {
    id: 'google',
    name: 'Google',
    country: 'アメリカ合衆国',
    usage: '食事・冷蔵庫・健康診断・体重計の写真の読み取り、健康に関するヒントや料理の画像の作成',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    country: 'アメリカ合衆国',
    usage: '栄養のアドバイスの作成、献立の作成',
  },
  perplexity: {
    id: 'perplexity',
    name: 'Perplexity',
    country: 'アメリカ合衆国',
    usage: '食事の写真から読み取った料理名・食材・量をもとにした栄養の推定',
  },
  aimlapi: {
    id: 'aimlapi',
    name: 'AI/ML API',
    country: 'エストニア',
    usage: 'AI 相談の文章や料理・食材の名前を、レシピや食材のデータから探すための数値化',
  },
};

/** 同意画面・設定ページに出す文面 (仮。ファイル先頭のコメントを参照) */
export const AI_CONSENT_COPY = {
  title: 'AI 機能で使う、日本国外の事業者へのデータ提供について',
  intro:
    'ほめゴハンの AI 機能（食事の写真の解析、献立の作成、AI 相談、健康診断結果の読み取りなど）は、' +
    'あなたが撮影・入力した内容を、日本国外にある次の事業者の AI に送って処理しています。',
  providersHeading: '提供先の事業者',
  dataHeading: '提供する情報',
  dataCategories: [
    '食事の写真と食事の記録（料理名・栄養の数値など）',
    '健康診断・血液検査の写真と数値',
    'AI 相談に入力した文章',
    '冷蔵庫の写真と食材の情報',
    '献立の作成に使う、好み・アレルギー・健康目標などの情報',
    '献立・買い物リストの料理名と食材の名前',
  ],
  purposesHeading: '利用する目的',
  purposes: [
    '写真から料理・食材・数値を読み取るため',
    '献立や栄養のアドバイスを作るため',
    'AI 相談に回答するため',
    '健康診断・血液検査の結果にコメントをつけるため',
    '料理の栄養を推定し、料理の画像を作るため',
  ],
  retentionHeading: '事業者での保存',
  retention:
    '送った内容は、各事業者のもとで、サービスの提供や不正利用の防止のために一定の期間保存されることがあります。' +
    '保存の期間や扱いは事業者ごとに異なり、各事業者の規約に従います。',
  withdrawalHeading: '同意の確認と撤回',
  withdrawal: '同意はいつでも、次のページで確認・撤回できます。',
  /** 同意しない場合の説明 (同意画面に出す) */
  declineNote:
    '同意しない場合、AI 機能（写真の解析、献立の作成、AI 相談など）はお使いいただけません。' +
    'あとからいつでも同意できます。',
  acceptLabel: '同意する',
  declineLabel: '同意しない',
  /** 画面を開くと自動で作る AI のコメント (栄養士のコメントなど) を、同意が無くて作らなかったときに出す一文 (同意画面は出さない) */
  automaticLockedNote: AI_CONSENT_AUTOMATIC_LOCKED_NOTE,
  /** AI 機能を使おうとしたが、同意が無くて止められたときの見出し (同意画面のタイトルの上に出す) */
  requiredLead: 'この機能を使うには、次の内容への同意が必要です。',
  settingsLinkLabel: 'AI へのデータ提供の同意（確認・撤回）',
  /** 設定ページ（確認・撤回）の文面 */
  settingsTitle: AI_CONSENT_SETTINGS_ENTRY_TITLE,
  /** 撤回の確認ダイアログの説明 */
  revokeNote:
    '同意を撤回すると、AI 機能（写真の解析、献立の作成、AI 相談など）は使えなくなります。' +
    'もう一度使うときは、あらためて同意が必要です。',
} as const;
