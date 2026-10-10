/**
 * #1131 個人データエクスポート: 出力するテーブルの許可リストと、出力しないテーブルの一覧。
 *
 * 【運用ルール】
 * - ユーザーに紐づく public テーブルを増やしたら、必ず ACCOUNT_EXPORT_TABLES (出力する) か
 *   ACCOUNT_EXPORT_EXCLUDED (出力しない。理由つき) のどちらかに分類する。
 *   分類漏れは tests/account-export-tables.test.ts が (本番スキーマのスナップショットと突き合わせて) 検知する。
 * - 出力する表には、必ず「本人の行だけ」に絞る scope を付ける。RLS だけに頼らない。
 *   recipes / recipe_collections / meals は他人の公開行・家族の行も返し、support_tickets / inquiries /
 *   personal_subscriptions などは運営ロールのユーザーなら全員分を返すため、絞り込みが無いと
 *   「自分のエクスポート」に他人のデータが混ざる。
 * - パスワード・トークン・外部サービスの ID・運営の内部メモのような秘密 / 内部情報の列は、
 *   omit (取得後に取り除く) か columns (最初から取得しない) で外す。
 * - 親テーブル経由の子テーブル (planned_meals など) は、親の user_id で絞る。
 */

import { weeklyMenuRequestErrorMessageForResponse } from './weekly-menu-request-error';

export type ExportRow = Record<string, unknown>;

/** 行の絞り込み方 */
export type ExportScope =
  /** 本人の ID が入っている列で絞る (例: user_id)。user_profiles だけは主キー id */
  | { kind: 'self'; column: string }
  /**
   * 親テーブル経由で絞る。親の parentColumn (user_id など) が本人の行に属する子だけを返す。
   * PostgREST の !inner 結合で親の行を引き当てる (子の外部キー fk が parent を指していること)。
   */
  | { kind: 'parent'; parent: string; fk: string; parentColumn: string };

export interface ExportTableSpec {
  /** public スキーマのテーブル名。出力 JSON の data 直下のキーにもなる */
  table: string;
  scope: ExportScope;
  /**
   * select 句。省略時は '*'。重い列 (jsonb の生成結果など) や内部列を取得したくないときだけ明示する。
   * 明示した場合は、本人の判定に使う列 (scope の column) を必ず含めること。
   */
  columns?: string;
  /** '*' で取得した後に取り除く列 (内部管理用・秘密の列) */
  omit?: readonly string[];
  /**
   * 並び順 (省略時は ['id'])。主キーのすべての列を含めること (含まないと、同じ値の行が
   * ページの境目で重複・欠落する)。読みやすさのために先頭へ日時などを足してよい。
   */
  orderBy?: readonly string[];
  /** 追加の完全一致の絞り込み (例: 運営の内部メッセージを除く is_internal = false) */
  eq?: Readonly<Record<string, string | number | boolean>>;
  /** 行ごとの最終整形 */
  transform?: (row: ExportRow, ctx: { userId: string }) => ExportRow;
}

const self = (column: string): ExportScope => ({ kind: 'self', column });
const viaParent = (parent: string, fk: string, parentColumn = 'user_id'): ExportScope => ({
  kind: 'parent',
  parent,
  fk,
  parentColumn,
});

/**
 * サポートの返信を書いた運営スタッフのユーザー ID は他人の識別子なので出力しない。
 * 代わりに「本人が書いたか / サポートが書いたか」だけを残す。
 */
function redactSupportMessageSender(row: ExportRow, ctx: { userId: string }): ExportRow {
  const { sender_id: senderId, ...rest } = row;
  return { ...rest, sender: senderId === ctx.userId ? 'user' : 'support' };
}

/**
 * 献立生成のリクエストの失敗の文 (error_message) には、Edge Function が捕まえた例外の文面
 * (DB の生のエラー文・Edge Function の応答の本文) がそのまま入っていることがある。
 * 状態の確認の API (GET /api/ai/menu/weekly/status) と同じく、こちらで書いた文 (同意・stale・中止・固定の文) だけを
 * そのまま出し、それ以外は固定の文にする (#1172)
 */
function redactWeeklyMenuRequestErrorMessage(row: ExportRow): ExportRow {
  if (!('error_message' in row)) return row;
  return { ...row, error_message: weeklyMenuRequestErrorMessageForResponse(row.error_message) };
}

/**
 * 書き出しで、保存された失敗の文の代わりに出す固定の文 (#1172)。
 * 画面が見分ける文 (同意の文など) を持たない列 (ai_action_logs.result.error・recipe_requests.error_message) に使う
 */
export const EXPORT_STORED_FAILURE_MESSAGE = '処理に失敗しました';

/** 保存された失敗の文を、書き出しに入れるときの値。空 (null・undefined・空文字) はそのまま、それ以外は固定の文 */
function storedFailureTextForExport(stored: unknown): unknown {
  if (stored === null || stored === undefined || stored === '') return stored;
  return EXPORT_STORED_FAILURE_MESSAGE;
}

/**
 * AI 相談のアクションの記録の結果 (ai_action_logs.result) を、書き出しに入れるときの形 (#1172)。
 *
 * 結果は runConsultationAction (src/lib/ai/consultation-action-executor.ts) が作り、execute / messages の route が保存する。
 * #1172 の前は、DB 操作の失敗の生のエラー文 (テーブル名・列名・制約名・衝突した値) を result.error にそのまま入れていて、
 * その行が残っている。いまの書き手が入れる文はこちらで書いた文だが、画面が見分ける文は無いので、
 * 空でない error はすべて固定の文にする (前の行と見分けない)。
 *   - null・undefined は null
 *   - オブジェクトでない値 (文字列・数・配列。書き手は書かない) は、中身を確かめずに null
 *   - オブジェクトは、error だけを固定の文にし、ほかの項目 (成功の itemId / created など) はそのまま
 */
function aiActionLogResultForExport(result: unknown): Record<string, unknown> | null {
  if (result === null || result === undefined || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  if (!('error' in record)) return record;
  return { ...record, error: storedFailureTextForExport(record.error) };
}

function redactAiActionLogResult(row: ExportRow): ExportRow {
  if (!('result' in row)) return row;
  return { ...row, result: aiActionLogResultForExport(row.result) };
}

/**
 * レシピのリクエストの失敗の文 (recipe_requests.error_message)。このリポジトリには書き手が無いが、
 * 列は失敗の文を入れるためのもので、中身を確かめられないので、空でなければ固定の文にする (#1172)
 */
function redactRecipeRequestErrorMessage(row: ExportRow): ExportRow {
  if (!('error_message' in row)) return row;
  return { ...row, error_message: storedFailureTextForExport(row.error_message) };
}

/** 出力するテーブル (この順で JSON に出る) */
export const ACCOUNT_EXPORT_TABLES: readonly ExportTableSpec[] = [
  // ── プロフィール・設定 ───────────────────────────────────────────
  {
    table: 'user_profiles',
    scope: self('id'),
    // 権限・凍結 / BAN の管理情報と、課金プランの内部キャッシュは本人向けのデータではない
    omit: [
      'roles',
      'is_banned',
      'banned_at',
      'banned_reason',
      'unban_at',
      'frozen_at',
      'frozen_reason',
      'frozen_by',
      'plan_key_cached',
    ],
  },
  { table: 'notification_preferences', scope: self('user_id') },
  { table: 'nutrition_targets', scope: self('user_id') },

  // ── 食事・献立 ──────────────────────────────────────────────────
  // meals は RLS で家族の行も返る。必ず user_id で絞る
  // hidden_by (#1101: 運営が隠したときの、操作した運営ユーザーの ID) は他人の識別子なので出力しない。
  // 隠した日時 (hidden_at) と理由 (hidden_reason: 'moderation:<action>' の識別子) は本人に関わる記録なので出力する
  { table: 'meals', scope: self('user_id'), omit: ['hidden_by'] },
  { table: 'meal_ai_feedbacks', scope: viaParent('meals', 'meal_id') },
  { table: 'meal_nutrition_estimates', scope: viaParent('meals', 'meal_id') },
  { table: 'user_daily_meals', scope: self('user_id') },
  { table: 'planned_meals', scope: viaParent('user_daily_meals', 'daily_meal_id') },
  { table: 'weekly_menus', scope: self('user_id') },
  {
    table: 'weekly_menu_requests',
    scope: self('user_id'),
    // 本人が入力した条件だけを出す。生成結果 (result_json 等。献立は planned_meals / weekly_menus に出力済み) と
    // ジョブ管理用の列 (worker_id / attempt_count 等) は取得しない
    columns:
      'id,user_id,start_date,status,prompt,constraints,inventory_image_url,detected_ingredients,' +
      'mode,target_date,target_meal_type,target_meal_id,error_message,created_at,updated_at',
    transform: redactWeeklyMenuRequestErrorMessage,
  },
  { table: 'pantry_items', scope: self('user_id') },
  { table: 'shopping_lists', scope: self('user_id') },
  { table: 'shopping_list_items', scope: viaParent('shopping_lists', 'shopping_list_id') },

  // ── レシピ ──────────────────────────────────────────────────────
  // recipes / recipe_collections は RLS で他人の公開行・システムのレシピ (user_id IS NULL) も返る
  // hidden_by は meals と同じ理由で出力しない (#1101)
  { table: 'recipes', scope: self('user_id'), omit: ['hidden_by'] },
  { table: 'recipe_collections', scope: self('user_id') },
  {
    table: 'recipe_collection_items',
    scope: viaParent('recipe_collections', 'collection_id'),
    orderBy: ['collection_id', 'recipe_id'],
  },
  // recipe_likes / recipe_comments は RLS 上「誰でも閲覧可」。必ず user_id で絞る
  { table: 'recipe_likes', scope: self('user_id'), orderBy: ['user_id', 'recipe_id'] },
  { table: 'recipe_comments', scope: self('user_id') },
  { table: 'recipe_flags', scope: self('reporter_id'), omit: ['reviewed_by'] },
  { table: 'recipe_requests', scope: self('user_id'), transform: redactRecipeRequestErrorMessage },

  // ── 健康 ────────────────────────────────────────────────────────
  { table: 'health_records', scope: self('user_id') },
  { table: 'health_goals', scope: self('user_id') },
  { table: 'health_checkups', scope: self('user_id') },
  { table: 'health_checkup_longitudinal_reviews', scope: self('user_id') },
  { table: 'blood_test_results', scope: self('user_id') },
  { table: 'blood_test_longitudinal_reviews', scope: self('user_id') },
  { table: 'health_insights', scope: self('user_id') },
  { table: 'health_streaks', scope: self('user_id') },
  { table: 'health_challenges', scope: self('user_id') },
  { table: 'daily_activity_logs', scope: self('user_id') },
  { table: 'user_performance_checkins', scope: self('user_id') },
  { table: 'performance_plans', scope: self('user_id') },

  // ── AI 相談 ─────────────────────────────────────────────────────
  { table: 'ai_consultation_sessions', scope: self('user_id') },
  {
    table: 'ai_consultation_messages',
    scope: viaParent('ai_consultation_sessions', 'session_id'),
    // 会話は時系列で読めるように。id は同時刻の行の順序を安定させる (ページングのため)
    orderBy: ['created_at', 'id'],
  },
  {
    table: 'ai_action_logs',
    scope: viaParent('ai_consultation_sessions', 'session_id'),
    // 結果 (result) の失敗の文 (error) には、#1172 の前に書かれた DB の生のエラー文が入っていることがある
    transform: redactAiActionLogResult,
  },

  // ── バッジ・チャレンジ ──────────────────────────────────────────
  {
    table: 'user_badges',
    scope: self('user_id'),
    // バッジの名前・説明も添える (badges は誰でも読める共通マスタ。条件式 condition_json は出さない)
    columns: '*,badge:badges(code,name,description)',
    orderBy: ['user_id', 'badge_id'],
  },
  // 同じ組織の参加者全員が RLS で読めるため、必ず user_id で絞る
  { table: 'organization_challenge_participants', scope: self('user_id') },

  // ── 家族 ────────────────────────────────────────────────────────
  // 本人の所属行だけ。同じ家族の他メンバーの行 (RLS では読める) は出さない
  { table: 'family_members', scope: self('user_id') },
  // 本人が代表者のグループだけ
  { table: 'family_groups', scope: self('representative_id') },

  // ── 契約・同意・問い合わせ ──────────────────────────────────────
  { table: 'terms_acceptances', scope: self('user_id') },
  { table: 'cookie_consents', scope: self('user_id') },
  { table: 'external_data_consents', scope: self('user_id') },
  {
    table: 'personal_subscriptions',
    scope: self('user_id'),
    // Stripe の顧客 / 契約 / 価格 ID と運営の備考は外部サービスの識別子・内部メモ
    omit: ['stripe_customer_id', 'stripe_subscription_id', 'stripe_price_id', 'notes'],
  },
  { table: 'coupon_redemptions', scope: self('user_id'), omit: ['approved_by'] },
  { table: 'gdpr_deletion_requests', scope: self('user_id'), omit: ['executed_by', 'notes'] },
  {
    table: 'announcement_reads',
    scope: self('user_id'),
    orderBy: ['user_id', 'announcement_id'],
  },
  { table: 'csat_feedbacks', scope: self('user_id') },
  // 運営ロールのユーザーは RLS で全員分が読める。必ず user_id で絞る
  { table: 'inquiries', scope: self('user_id'), omit: ['admin_notes'] },
  { table: 'support_tickets', scope: self('user_id'), omit: ['assignee_id'] },
  {
    table: 'support_ticket_messages',
    scope: viaParent('support_tickets', 'ticket_id'),
    orderBy: ['created_at', 'id'],
    // 運営の内部メモ (is_internal = true) は本人に見せない
    eq: { is_internal: false },
    transform: redactSupportMessageSender,
  },
];

/**
 * 出力しないテーブルと、その理由。
 * ユーザーの識別列を持つ、または出力する表の子であるにもかかわらず出していない表だけを載せる
 * (カタログ / 献立データセットのような、ユーザーと無関係な表は対象外)。
 */
export const ACCOUNT_EXPORT_EXCLUDED: Readonly<Record<string, string>> = {
  // 認証情報・セキュリティ
  password_history: 'パスワードのハッシュ (認証情報)',
  user_push_tokens: '端末のプッシュ通知トークン (認証情報に準ずる)',
  user_sessions_metadata: 'ログインセッションの識別子・端末情報 (セキュリティ情報)',
  native_bridge_codes: 'モバイル WebView 認証ブリッジのワンタイムコード (アクセス / リフレッシュトークンを含む。有効 60 秒・使うと消える)',
  family_invites: '招待トークンと、他人のメールアドレスを含む',
  family_promotion_requests: '本人同意用のトークンと、他人のメールアドレスを含む',

  // 運営・内部の記録
  admin_user_notes: '運営スタッフが書いた内部メモ',
  moderation_flags: '運営によるモデレーションの内部記録',
  membership_audit: '所属変更の監査ログ (操作した人・相手の ID を含む)',
  experiment_assignments: 'A/B テストの内部割り当て',
  app_logs: 'アプリの動作ログ (内部のエラー記録)',
  ai_content_logs: 'AI 生成の内部ログ (費用・モデレーション用の列を含む)',
  llm_usage_logs: 'LLM 利用量の内部台帳 (コスト等)',
  ai_usage_counters:
    'AI 利用回数の内部台帳 (プランの利用制限のための記録。本人が読める RLS ポリシーが無く、service_role だけが読み書きする)',
  email_delivery_logs: 'メール配信の運用ログ',
  meal_nutrition_debug_logs: '栄養計算のデバッグログ',
  meal_image_jobs: '画像生成ジョブのキュー (処理状態・リース情報などの内部データ)',
  shopping_list_requests: '買い物リスト生成ジョブの処理状態 (結果は shopping_lists に出力済み)',

  // 再生成できる・システムが算出した派生データ
  nutrition_feedback_cache: 'AI フィードバックのキャッシュ (再生成できる)',
  derived_recipes: 'AI が作った派生レシピの内部データ (embedding ベクトルを含む。献立は planned_meals に出力済み)',
  user_metrics: 'システムが計算した集計指標 (派生データ)',
  user_segment_rankings: '他ユーザーとの比較から算出したランキング (派生データ)',

  // 他人の情報を含む・共有されているレコード
  organizations: '組織そのもの (共有エンティティ。所属情報は user_profiles に含まれる)',
  ownership_transfer_proposals: '2 者間の所有権移譲の提案 (相手のユーザー ID を含む)',
  referral_rewards: '紹介した人 / された人の 2 者間のレコード (相手のユーザー ID を含む。現行機能では未使用)',
  buddies: '2 者間のレコード (相手のユーザー ID を含む。現行機能では未使用)',
  buddy_actions: '2 者間のレコード (相手のユーザー ID を含む。現行機能では未使用)',
  legacy_family_groups: '旧家族機能。家族 (他人) の個人情報を含み、現行機能では未使用',
  legacy_family_members: '旧家族機能。家族 (他人) の個人情報を含み、現行機能では未使用',
  family_meal_logs: '旧家族機能 (legacy_family_*) の記録。現行機能では未使用',

  // 技術的な理由
  nps_surveys: '本人が読める RLS ポリシーが無い (運営のみ閲覧可)。出力するには SELECT ポリシーの追加 (migration) が必要',
};
