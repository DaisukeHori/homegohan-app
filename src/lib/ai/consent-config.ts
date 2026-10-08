/**
 * 外国の AI 事業者への提供の同意: 事業者の一覧・文面・版 (サーバーとブラウザの両方から使う)
 *
 * T15 (#1154 / #1133 / #1169)。このファイルはサーバー専用の import (next/headers など) を持たない。
 * 同意画面 (src/components/consent/AiDataConsentModal.tsx) と設定ページ (src/app/(main)/settings/ai-consent/page.tsx) は、
 * ここを import する。DB を読み書きする関数は src/lib/ai/consent.ts (サーバー専用) にある。
 * (consent.ts はここの内容を再エクスポートするので、サーバー側のコードは consent.ts だけ読めばよい)
 *
 * ┌─ 文面は仮 (DRAFT) ─────────────────────────────────────────────────────────────┐
 * │ AI_CONSENT_COPY の文面は、弁護士の確認が済むまで仮のもの。                         │
 * │ 確認後に文面を差し替えるときは、必ず AI_CONSENT_VERSION も新しい版に変えること。   │
 * │ 版を変えると、古い版に同意した人にも、もう一度同意を確認する画面が出る。           │
 * │ (同意の記録には、同意したときの版が入る: external_data_consents.policy_version)     │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * 弁護士に確認してもらう点 (文面を確定するときの宿題):
 *   - 事業者の正式名称・所在国・所在地 (いまは画面に出す呼び名と国だけ)
 *   - 各事業者での保存期間と、送った内容を事業者の AI の学習に使うかどうか (いまは「事業者ごとに異なる」としか書いていない)
 *   - 提供する情報の範囲 (写真・数値・相談文のほか、献立の作成に使う好み・アレルギー・健康目標を含めるか)
 *   - 「あとで」を選んだ人 / 撤回した人への説明 (いまは AI への送信を止めていないので、止まるとは書いていない)
 *   - Perplexity を事業者に加えるか。Edge Function の栄養推定 (supabase/functions/_shared/perplexity-nutrition.ts) が使っていて、
 *     送るのは料理名・調理法・見えている食材・量だけ (写真・利用者を特定する情報は送らない)。弁護士が「必要」と言うまで一覧に入れない。
 *     加えるなら、DB の CHECK (external_data_consents.provider は xai / anthropic / google / openai のみ) の変更が先に要る。
 *     Anthropic は現在 AI の呼び出しに使っていないので、一覧に入れていない
 *   - 画面を開くと自動で AI に送る処理 (ホームの栄養アドバイス、週間献立のヒント・栄養士コメント) に、同意画面を出すか
 *     (いまは「利用者が AI の操作を始めたとき」の入口だけに出している。自動の送信は T18 の強制のときに扱いを決める)
 */

/**
 * 同意を取る外国の AI 事業者。external_data_consents.provider の値。
 * (DB の CHECK は xai / anthropic / google / openai。いま AI の呼び出しに使っているのは次の 3 社)
 */
export const AI_CONSENT_PROVIDERS = ['xai', 'google', 'openai'] as const;

export type AiConsentProvider = (typeof AI_CONSENT_PROVIDERS)[number];

/**
 * 同意の文面の版。AI_CONSENT_COPY を変えたら、必ずこの値も変える (上のコメントを参照)。
 * 'draft-' で始まる版は、弁護士の確認前の仮の文面への同意であることを表す。
 */
export const AI_CONSENT_VERSION = 'draft-2026-10-08';

/** 設定ページ (同意の確認・撤回) の URL */
export const AI_CONSENT_SETTINGS_PATH = '/settings/ai-consent';

/**
 * 「あとで」を選んだあと、同じブラウザでもう一度確認するまでの時間 (ミリ秒)。24 時間。
 * 「あとで」はサーバーに記録しない (同意していない人の行は作らない)。ブラウザの localStorage に期限だけを持つ。
 */
export const AI_CONSENT_LATER_SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * 「あとで」を選んだ期限 (エポックミリ秒) を入れる localStorage のキー。
 * ログアウト時に消す (src/lib/user-storage.ts の USER_SCOPED_KEYS に同じ値を入れている)。
 */
export const AI_CONSENT_LATER_STORAGE_KEY = 'ai_consent_later_until';

/**
 * 事業者ごとの状態 (GET /api/ai/consent の応答の形。サーバーの src/lib/ai/consent.ts が作り、ブラウザが読む)。
 *   - granted : 現行の版 (AI_CONSENT_VERSION) に同意している
 *   - outdated: 古い版 (または版を記録する前) に同意している。もう一度確認する
 *   - none    : 有効な同意が無い (一度も同意していない / 撤回した)
 */
export type AiConsentProviderState = 'granted' | 'outdated' | 'none';

export interface AiConsentProviderStatus {
  provider: AiConsentProvider;
  state: AiConsentProviderState;
  /** 有効な同意の日時 (state が granted / outdated のとき) */
  consentedAt: string | null;
  /** 有効な同意の版 (state が granted / outdated のとき。版を記録する前の行は null) */
  policyVersion: string | null;
  /** 直近の撤回 (または新しい版への置き換え) の日時 (state が none のとき) */
  revokedAt: string | null;
}

export interface AiConsentStatus {
  /** 現行の文面の版 */
  version: string;
  /** すべての事業者について、現行の版に同意している */
  consented: boolean;
  providers: AiConsentProviderStatus[];
  /** 同意の日時 (consented のとき。事業者のうち最も新しいもの) */
  consentedAt: string | null;
  /** 直近の撤回の日時 (有効な同意が 1 つも無いとき) */
  revokedAt: string | null;
}

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
 * 事業者ごとの表示内容。使い道は 2026-10 時点のコードの実態に合わせた概要:
 *   - xAI: src/lib/ai/fast-llm.ts (AI 相談、健康診断・血液検査へのコメント、献立の作成)
 *   - Google: src/lib/ai/gemini-json.ts と Edge Function (写真の読み取り、健康インサイト、画像の作成)
 *   - OpenAI: src/app/api/ai/nutrition/feedback/route.ts と Edge Function の v4-fast-llm (栄養のアドバイス、献立の作成)
 */
export const AI_CONSENT_PROVIDER_INFO: Record<AiConsentProvider, AiConsentProviderInfo> = {
  xai: {
    id: 'xai',
    name: 'xAI',
    country: 'アメリカ合衆国',
    usage: 'AI 相談への回答、健康診断・血液検査の結果へのコメント、献立の作成',
  },
  google: {
    id: 'google',
    name: 'Google',
    country: 'アメリカ合衆国',
    usage: '食事・冷蔵庫・健康診断・体重計の写真の読み取り、健康に関するヒントや画像の作成',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    country: 'アメリカ合衆国',
    usage: '栄養のアドバイスの作成、献立の作成',
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
  ],
  purposesHeading: '利用する目的',
  purposes: [
    '写真から料理・食材・数値を読み取るため',
    '献立や栄養のアドバイスを作るため',
    'AI 相談に回答するため',
    '健康診断・血液検査の結果にコメントをつけるため',
  ],
  retentionHeading: '事業者での保存',
  retention:
    '送った内容は、各事業者のもとで、サービスの提供や不正利用の防止のために一定の期間保存されることがあります。' +
    '保存の期間や扱いは事業者ごとに異なり、各事業者の規約に従います。',
  withdrawalHeading: '同意の確認と撤回',
  withdrawal: '同意はいつでも、次のページで確認・撤回できます。',
  /** 「あとで」を選んだときの説明。AI への送信を止めていない間だけ出す */
  laterNote: '「あとで」を選んでも、今は AI 機能をそのままお使いいただけます。',
  acceptLabel: '同意する',
  laterLabel: 'あとで',
  settingsLinkLabel: 'AI へのデータ提供の同意（確認・撤回）',
  /** 設定ページ（確認・撤回）の文面 */
  settingsTitle: 'AI へのデータ提供の同意',
  /** 撤回の確認ダイアログの説明。AI への送信を止めていない間は、止まるとは書かない */
  revokeNote:
    '現在は、同意を撤回しても AI 機能は引き続きお使いいただけます。' +
    '撤回したあとに AI 機能を使うときは、あらためて同意の確認画面が表示されます。',
} as const;
