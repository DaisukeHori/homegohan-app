/**
 * AI 相談の操作 → 変わる表 → 出す Web のページ の閉じた一覧 (#2195 V1)。
 *
 * Web の AI 相談 (src/components/AIChatBubble.tsx) の提案の実行が成功すると、開いているページは
 * useAiConsultationDataRefetch (src/hooks/useAiConsultationDataRefetch.ts) で自分の取得をもう一度走らせる。
 * どのページが受け手になるべきかを手で書いた一覧で決めていたため、受け手の抜けと「取り直しが前の値を残す」書き方が
 * 敵対レビューの周ごとに 1〜2 件ずつ見つかった。ここに表を置き、tests/ai-consultation-refetch-coverage-2195.test.ts が
 * ソースの構文木から同じ表を組み立てて突き合わせる:
 *
 *   1. AI_CONSULTATION_ACTION_WRITTEN_TABLES: 実行の各 case (src/lib/ai/consultation-action-executor.ts の
 *      runConsultationAction) が書く表。case から名前でたどれる宣言 (src・packages の関数) の `.from('<表>')` の書き込みと、
 *      呼ぶ DB の関数 (AI_CONSULTATION_RPC_WRITTEN_TABLES) と Edge Function (AI_CONSULTATION_EDGE_FUNCTIONS) が書く表の和に、
 *      一致しなければ赤
 *   2. AI_CONSULTATION_REFETCH_PAGES: src/app/(main) のページのうち、AI が書く表を読むもの全部。ページから名前でたどれる
 *      部品・hook の Supabase の読み取りと、ページが呼ぶ API の route (GET) が読む表から決める。表に無いページが
 *      AI が書く表を読んでいたら赤 (新しいページ・新しい AI の操作で漏れたら気付く)。
 *      受け手 (receiver) は useAiConsultationDataRefetch / useAiConsultationRefetchKey を使い、開いたときとパネルが読むもの全部を
 *      取り直す (tests/helpers/ai-refetch-read-recorder.ts で描画して確かめる)。除外 (excluded) は理由を書く
 *
 * user_profiles は、AI 相談が書く列 (AI_CONSULTATION_WRITTEN_COLUMNS) を読むときだけ「AI が書く表を読む」と数える
 * (ほとんどの route が権限・所属の列を読むため。列を数えられない読み取り (select('*') など) は読むと数える)。
 *
 * このファイルはテストと設計の正本のための表で、アプリの動きには使わない。
 */
import { AI_PROFILE_PREFERENCE_FIELD_NAMES } from '@/lib/ai/profile-preference-updates';

/** AI 相談の実行が書く表 */
export const AI_CONSULTATION_WRITTEN_TABLE_NAMES = [
  'ai_usage_counters',
  'app_logs',
  'health_goals',
  'health_records',
  'health_streaks',
  'llm_usage_logs',
  'meal_image_jobs',
  'meal_nutrition_debug_logs',
  'nutrition_targets',
  'pantry_items',
  'planned_meals',
  'recipe_collections',
  'recipe_likes',
  'shopping_list_items',
  'shopping_lists',
  'user_daily_meals',
  'user_profiles',
  'weekly_menu_requests',
] as const;

export type AiConsultationWrittenTable = (typeof AI_CONSULTATION_WRITTEN_TABLE_NAMES)[number];

/** 献立の生成 (Edge Function generate-menu-v4 / v5) が書く表 */
const MENU_GENERATION_TABLES = [
  'ai_usage_counters',
  'app_logs',
  'llm_usage_logs',
  'meal_image_jobs',
  'meal_nutrition_debug_logs',
  'planned_meals',
  'user_daily_meals',
  'weekly_menu_requests',
] as const satisfies readonly AiConsultationWrittenTable[];

/**
 * 実行の各 case が書く表 (1 の正本)。case の名前は runConsultationAction の switch の case と一致する (テストが確かめる)
 */
export const AI_CONSULTATION_ACTION_WRITTEN_TABLES = {
  generate_day_menu: MENU_GENERATION_TABLES,
  generate_week_menu: MENU_GENERATION_TABLES,
  generate_single_meal: MENU_GENERATION_TABLES,
  update_meal: ['ai_usage_counters', 'app_logs', 'meal_image_jobs', 'planned_meals'],
  delete_meal: ['meal_image_jobs', 'planned_meals'],
  complete_meal: ['planned_meals'],
  add_to_shopping_list: ['app_logs', 'shopping_list_items', 'shopping_lists'],
  update_shopping_item: ['app_logs', 'shopping_list_items'],
  delete_shopping_item: ['shopping_list_items'],
  check_shopping_item: ['shopping_list_items'],
  add_pantry_item: ['app_logs', 'pantry_items'],
  update_pantry_item: ['app_logs', 'pantry_items'],
  delete_pantry_item: ['app_logs', 'pantry_items'],
  suggest_recipe: [],
  like_recipe: ['recipe_likes'],
  add_recipe_to_collection: ['app_logs', 'recipe_collections'],
  update_nutrition_target: ['app_logs', 'nutrition_targets'],
  set_health_goal: ['app_logs', 'health_goals'],
  update_health_goal: ['app_logs', 'health_goals'],
  delete_health_goal: ['health_goals'],
  add_health_record: ['app_logs', 'health_records', 'health_streaks', 'user_profiles'],
  update_health_record: ['app_logs', 'health_records'],
  update_profile_preferences: ['app_logs', 'user_profiles'],
} as const satisfies Readonly<Record<string, readonly AiConsultationWrittenTable[]>>;

export type AiConsultationActionType = keyof typeof AI_CONSULTATION_ACTION_WRITTEN_TABLES;

/**
 * 受付の時点ではまだ書き終えず、裏の処理 (Edge Function) が後から書く AI の操作 (#2195 V1 の整合ゲートの是正)。
 * キー = 実行の case のうち、Edge Function を呼ぶ (`.functions.invoke(...)` か '/functions/v1/<名前>' の URL) もの全部
 * (tests/ai-consultation-refetch-coverage-2195.test.ts がソースの構文木から数えて突き合わせる)。
 *   - watched: 実行の結果が生成の受付 ({ requestId, status: 'processing' }) で、受け手の共通の hook
 *     (src/hooks/useAiConsultationDataRefetch.ts) がその依頼を終わるまで見張り、終わったらもう一度取り直す
 *     (src/lib/ai/consultation-generation-watch.ts)。受け手のページは全部この hook を使う (同じテストが数える) ので、
 *     どの受け手も受付と完了の両方で取り直す
 *   - notWatched: 見張らない理由を事実で書く
 */
export const AI_CONSULTATION_DEFERRED_WRITE_ACTIONS: Readonly<
  Partial<Record<AiConsultationActionType, { kind: 'watched' } | { kind: 'notWatched'; reason: string }>>
> = {
  generate_day_menu: { kind: 'watched' },
  generate_week_menu: { kind: 'watched' },
  generate_single_meal: { kind: 'watched' },
  update_meal: {
    kind: 'notWatched',
    reason:
      '画面に出す献立の中身 (料理の名前・栄養など。planned_meals) は受付の時点で書き終えていて、受付の取り直しで出る。後から書くのは料理の画像だけ (料理画像のジョブ meal_image_jobs → Edge Function process-meal-image-jobs)。手で献立を変えたとき (PUT /api/meal-plans/meals/[id] など) も画面は画像の完了を見張らず、読み込み直したときに出る (同じ挙動)。実行の結果に生成の依頼 (weekly_menu_requests) の id は無く、生成の状態の確認 (GET /api/ai/menu/weekly/status) では見張れない',
  },
};

/**
 * 実行がたどる DB の関数 (rpc) が書く表。definedIn はその関数 (と、その関数が呼ぶ関数) を作る migration で、
 * テストは書く表がそのファイルに `public.<表>` として出てくることを確かめる (関数の本体の解析はしない — 検査の限界)
 */
export const AI_CONSULTATION_RPC_WRITTEN_TABLES: Readonly<
  Record<string, { tables: readonly AiConsultationWrittenTable[]; definedIn: readonly string[] }>
> = {
  consume_ai_usage: { tables: ['ai_usage_counters'], definedIn: ['supabase/migrations/20261011020000_ai_daily_limits.sql'] },
  consume_ai_usage_capped: {
    tables: ['ai_usage_counters'],
    definedIn: ['supabase/migrations/20261014100000_ai_usage_feature_daily_cap.sql'],
  },
  refund_ai_usage: { tables: ['ai_usage_counters'], definedIn: ['supabase/migrations/20261011020000_ai_daily_limits.sql'] },
  planned_meals_set_completed: {
    tables: ['planned_meals'],
    definedIn: ['supabase/migrations/20261025130000_planned_meals_set_completed_rpc.sql'],
  },
  get_or_create_active_shopping_list: {
    tables: ['shopping_lists'],
    definedIn: ['supabase/migrations/20261008120000_shopping_list_active_lock.sql'],
  },
  append_recipe_to_collection: {
    tables: ['recipe_collections'],
    definedIn: ['supabase/migrations/20261101120000_recipe_collections_append_recipe_rpc.sql'],
  },
  // 献立の生成・料理の画像の生成 (Edge Function) が読むだけの関数 (書く表は無い)
  ai_plan_feature_daily_cap: { tables: [], definedIn: [] },
  search_ingredients_by_text_similarity: { tables: [], definedIn: [] },
  search_ingredients_full_by_embedding: { tables: [], definedIn: [] },
  search_menu_examples: { tables: [], definedIn: [] },
  search_recipes_with_nutrition: { tables: [], definedIn: [] },
};

/**
 * 名前を文字列の定数に解けない rpc の呼び出しの場所 (ファイル) と、その理由。名前はそこへ渡す側のリテラルで数える
 */
export const AI_CONSULTATION_UNRESOLVED_RPC_CALL_FILES: Readonly<Record<string, string>> = {
  'src/lib/plan/entitlements.ts':
    'adminPlanRpcClient の rpc は受け取った名前をそのまま渡す包み。名前は同じファイルの client.rpc(\'consume_ai_usage\' などのリテラル) で数える',
};

/**
 * 実行が呼ぶ Edge Function。`.functions.invoke(<変数>)` の名前は定数に解けないので、invoke を呼ぶ case はこの一覧の全部を呼びうるとみなす。
 * URL ('/functions/v1/<名前>') で呼ぶものは、テストが文字列から名前を読む
 */
export const AI_CONSULTATION_INVOKED_EDGE_FUNCTIONS = ['generate-menu-v4', 'generate-menu-v5'] as const;

/** Edge Function の入口のファイル (supabase/functions/<名前>/index.ts) をたどって書く表を数える */
export const AI_CONSULTATION_EDGE_FUNCTION_ENTRY = (name: string): string => `supabase/functions/${name}/index.ts`;

/**
 * 表を読むときに、AI 相談が書く列だけを数える表 (ここに無い表は、どの列を読んでも数える)。
 * user_profiles: AI 相談が書くのは update_profile_preferences の許す欄 (AI_PROFILE_PREFERENCE_FIELD_NAMES) と、
 * add_health_record の体重 (weight) と、その 2 つのあとに書いた後の行から計算し直すプロフィールの完成度 (profile_completeness。
 * src/lib/profile-completeness.ts の refreshProfileCompleteness。#2201 U4) だけ
 */
export const AI_CONSULTATION_WRITTEN_COLUMNS: Readonly<Partial<Record<AiConsultationWrittenTable, readonly string[]>>> = {
  user_profiles: [...new Set([...AI_PROFILE_PREFERENCE_FIELD_NAMES.keys(), 'weight', 'profile_completeness'])].sort(),
};

/**
 * 書き込みの値がリテラルでない書き込みの、値を作る関数 (関数 → 表)。その関数が返すキーは、AI_CONSULTATION_WRITTEN_COLUMNS の
 * 列に限られる (テストが関数を動かして確かめる)
 */
export const AI_CONSULTATION_COLUMN_SANITIZERS: Readonly<Record<string, AiConsultationWrittenTable>> = {
  sanitizeAiProfilePreferenceUpdates: 'user_profiles',
};

export interface AiConsultationRefetchReceiver {
  kind: 'receiver';
  /** このページが読む AI が書く表 (テストがソースから数えたものと一致する) */
  aiTables: readonly AiConsultationWrittenTable[];
  /**
   * 開いたとき (とパネル) に読むもののうち、取り直しで読まなくてよいもの (名前 → 理由)。
   * 名前ごとの今の読み取りの鍵 ('GET /api/...' / 'from:<表>' (AI_CONSULTATION_WRITTEN_COLUMNS の表は 'from:<表>?select=<列>') /
   * 'rpc:<名前>') は、描画のテストが
   * tests/helpers/ai-refetch-read-recorder.ts の expectRefetchReadsCoverMount に渡す (日付の入った鍵を表に固定で書けないため)
   */
  mountReadsNotRefetched?: Readonly<Record<string, string>>;
}

/**
 * 除外 (取り直さない) のページ。理由 (reason) は次のどれかを事実で書く:
 *   - AI 相談の成功で画面に出す値が変わらない (読むが画面に出さない・自分以外の行だけを出す・静的な数えの見かけの当たり)
 *   - 変わりうる値を出している間、入力の部品かモーダルがいつも出ていて取り直しの番兵が止める (alwaysBlockedWhileShown)
 *   - 記録・作成の入力の流れの段の途中で読んだ値で、取り直すと入力の途中を上書きし、読み込み直しでも流れの最初に戻る (FORM_FLOW_REASON)
 * 「AI 相談が変えうるのは自分の名前の 1 行で…」のように、変わりうる値を画面に出すことを認めたまま取り直さないのは除外の理由にならない
 * (受け手にする。#2195 V1 R3: 家族の画面が自分の名前を出すのに除外で、AI 相談で名前を変えても古いまま残った)
 */
export interface AiConsultationRefetchExcluded {
  kind: 'excluded';
  aiTables: readonly AiConsultationWrittenTable[];
  /** AI_CONSULTATION_WRITTEN_COLUMNS の表について、このページが読む AI が書く列 (テストが数えたものと一致する) */
  aiColumns?: Readonly<Partial<Record<AiConsultationWrittenTable, readonly string[]>>>;
  reason: string;
  /**
   * AI が書く値を画面に出している間、入力の部品かモーダルがいつも出ていて取り直しの番兵 (isAiConsultationRefetchBlocked) がいつも止める。
   * true のページは、AI が書く値を出した状態で番兵が止めることを描画のテスト (tests/helpers/ai-refetch-read-recorder.ts の
   * expectRefetchAlwaysBlockedWhileShown) で確かめる (tests/ai-consultation-refetch-coverage-2195.test.ts がテストがあることを数える)
   */
  alwaysBlockedWhileShown?: true;
}

export type AiConsultationRefetchPageEntry = AiConsultationRefetchReceiver | AiConsultationRefetchExcluded;

/** 入力の部品がいつも出ているか、流れの途中で読む画面の除外の理由 */
const FORM_FLOW_REASON =
  '記録・作成の入力の流れの画面。AI が書く表を読むのは、日付を選んだ・写真を解析した・ボタンを押したときの段の途中の値で、取り直すと入力の途中を上書きする (読み込み直しでも流れの最初に戻る)';

/** MFA の画面が MFA_API_PATHS (src/lib/auth/mfa/client.ts) を参照することで数えた見かけの読み取り */
const MFA_PATH_TABLE_REASON =
  'MFA の API のパスの表 (MFA_API_PATHS) の 1 つとして運営の管理者の一覧 (/api/super-admin/admins) の URL を数えた見かけの当たり。この画面はその URL を取らない (管理者の一覧は運営の画面の部品だけが取る)';

/** 2 の正本。キーは src/app/(main) の中のページの URL の道 ('/meals/[id]' のように動的な区切りはそのまま) */
export const AI_CONSULTATION_REFETCH_PAGES: Readonly<Record<string, AiConsultationRefetchPageEntry>> = {
  '/badges': { kind: 'receiver', aiTables: ['planned_meals', 'user_daily_meals', 'weekly_menu_requests'] },
  // 比較の順位は集計の表 (user_segment_rankings など) から読み、AI が書く表を読まない。表示中の期間をもう一度取るだけの受け手
  '/comparison': { kind: 'receiver', aiTables: [] },
  // 家族の画面に出すメンバーの名前は、display_name の無いメンバー (自分を含む) に名前の API (/api/family/members/names) が
  // プロフィールの今の名前 (user_profiles.nickname) を当てたもの。AI 相談の update_profile_preferences は自分の nickname を書く
  '/family/dashboard': { kind: 'receiver', aiTables: ['user_profiles'] },
  '/family/members': { kind: 'receiver', aiTables: ['user_profiles'] },
  // 自分の詳細を開いているとき、名前の API が当てた自分の nickname を出す
  '/family/members/[id]': { kind: 'receiver', aiTables: ['user_profiles'] },
  // 提案者の名前 (user_profiles.nickname) は、user_profiles の SELECT が本人の行だけの RLS なので、申し出た本人が自分の申し出の画面を
  // 開いたときだけ出る (自分の名前。ほかの人が開くと読めず「代表者」「(不明)」)
  '/family/transfer-accept/[proposal_id]': { kind: 'receiver', aiTables: ['user_profiles'] },
  '/org/transfer-accept/[proposal_id]': { kind: 'receiver', aiTables: ['user_profiles'] },
  '/health': { kind: 'receiver', aiTables: ['health_goals', 'health_records', 'health_streaks'] },
  // 検査値の基準の範囲と判定は、プロフィールの性別 (GET /api/profile の gender) で選ぶ。AI 相談の update_profile_preferences は gender を書く
  '/health/blood-tests': {
    kind: 'receiver',
    mountReadsNotRefetched: {
      bloodTestResults:
        '血液検査の結果 (GET /api/health/blood-tests。blood_test_results と blood_test_longitudinal_reviews) は AI 相談が書かない表。取り直すのは基準値を選ぶ性別だけ',
    },
    aiTables: ['user_profiles'],
  },
  '/health/checkups/[id]': {
    kind: 'receiver',
    mountReadsNotRefetched: {
      checkup:
        '健康診断の結果 (GET /api/health/checkups/<id>。health_checkups) は AI 相談が書かない表。取り直すのは基準値を選ぶ性別だけ',
    },
    aiTables: ['user_profiles'],
  },
  '/health/goals': { kind: 'receiver', aiTables: ['health_goals'] },
  '/health/graphs': { kind: 'receiver', aiTables: ['health_goals', 'health_records'] },
  '/health/streaks': { kind: 'receiver', aiTables: ['health_records', 'health_streaks'] },
  '/home': {
    kind: 'receiver',
    mountReadsNotRefetched: {
      nutritionAnalysisWithAi:
        '開いたときの栄養の分析 (GET /api/ai/nutrition-analysis の includeAdvice・includeSuggestion つき。LLM を 1 回呼び、上限に数えない枠の安全弁 nutrition_advice_auto を 1 回使う)。取り直しは同じ API を AI を付けずに読み (点数・課題・栄養素の比べ。AI 相談が書く献立から計算する値)、AI のアドバイスと今日のアドバイスの帯は前の値を残す (成功のたびの LLM の費用と安全弁の消費をやめる。#2201 U4)。ただし、開いたときの読み込み中に始まった取り直し (refetchReadMode の値が mount) はその読み込みの役を引き継ぐ。引き継ぐ読み込みがまだ AI つきの読み取りを始めていなければ AI つきで読み、始めていれば AI を付けずに読む (AI を 2 回呼ばない。src/hooks/useHomeData.ts の refetch と aiAnalysisReadInLoadRef。#2201 U1・#2206 G3)',
      orgChallenges:
        '組織のチャレンジの入り口 (OrgChallengeEntry。組織に入っている人にだけ描く) が描いたときに 1 回読む GET /api/org/my-challenges。読むのは組織のチャレンジ (organization_challenges)・自分の参加の行 (organization_challenge_participants)・参加者の数 (DB の関数 get_org_challenge_aggregates)・所属 (user_profiles の organization_id・department_id・org_role) で、どれも AI 相談が書かない表と列 (参加の進み具合 current_value は毎日の集計 update_org_challenge_progress が書く)',
    },
    aiTables: [
      'health_goals',
      'health_records',
      'health_streaks',
      'nutrition_targets',
      'pantry_items',
      'planned_meals',
      'shopping_list_items',
      'shopping_lists',
      'user_daily_meals',
      'user_profiles',
    ],
  },
  '/meals/[id]': { kind: 'receiver', aiTables: ['planned_meals', 'user_daily_meals', 'user_profiles'] },
  '/menus/weekly': {
    kind: 'receiver',
    mountReadsNotRefetched: {
      adjacentWeekPrefetch:
        '前後の週の献立の先読み (週の切り替えを速くする控え weekDataCache。画面には出さない。読めなかった (非 ok) 週は控えに書かない)。取り直しは控えを捨てるので、その週へ移ったときに読み直す',
      weekStartDay:
        '週の始まりの日 (user_profiles.week_start_day)。AI 相談が書かない列 (AI_CONSULTATION_WRITTEN_COLUMNS に無い) で、設定の画面で変える',
      familyMenu:
        '家族の献立 (useFamilyMenu の GET /api/family/menu。家族に入っていて、切り替えで自分以外のメンバーを出すときだけ読む)。返すのは DB の関数 family_menu_visible_members が選ぶ自分以外のメンバー (tm.user_id <> auth.uid()。tests/integration/rls/family-menu-visibility.test.ts が実 DB で確かめる) の献立だけで、AI 相談が書く献立 (planned_meals・user_daily_meals) はログインしている人の行だけ (本人の行だけの RLS と、実行の case の本人の確かめ) なので AI 相談で変わらない。家族の切り替えを適用したときに読み直す',
    },
    aiTables: [
      'pantry_items',
      'planned_meals',
      'shopping_list_items',
      'shopping_lists',
      'user_daily_meals',
      'user_profiles',
      'weekly_menu_requests',
    ],
  },
  '/pantry': { kind: 'receiver', aiTables: ['pantry_items'] },
  '/profile': {
    kind: 'receiver',
    aiTables: ['nutrition_targets', 'planned_meals', 'user_daily_meals', 'user_profiles', 'weekly_menu_requests'],
  },
  '/profile/nutrition-targets': { kind: 'receiver', aiTables: ['nutrition_targets', 'user_profiles'] },

  '/health/record': { kind: 'excluded', aiTables: ['health_records'], reason: FORM_FLOW_REASON },
  '/meals/new': { kind: 'excluded', aiTables: ['health_records', 'pantry_items'], reason: FORM_FLOW_REASON },
  '/family/representative-transfer': {
    kind: 'excluded',
    aiTables: ['user_profiles'],
    aiColumns: { user_profiles: ['nickname'] },
    alwaysBlockedWhileShown: true,
    reason:
      "AI が書く表から読むのは、代表を譲る相手の候補の名前 (名前の API /api/family/members/names が display_name の無い候補に当てる user_profiles.nickname) だけ。候補は自分以外の大人 (.neq('user_id', 自分)) で、AI 相談が nickname を書くのは自分の行だけなので、出す名前は AI 相談で変わらない。加えて、候補の名前を出している間は候補の選択 (input radio) と理由 (textarea) がいつも出ていて、取り直しの番兵がいつも止める",
  },
  '/settings/membership': {
    kind: 'excluded',
    aiTables: ['user_profiles'],
    aiColumns: { user_profiles: ['nickname'] },
    reason:
      'AI が書く列は、自分のプロフィールを読む select に入れた名前 (user_profiles.nickname) だけで、読んだ名前を画面のどこにも使わない (読んだ行から使うのは family_id・organization_id・org_role だけ)。所属 (家族・組織) と共有の設定は AI 相談が書かない表と列',
  },
  '/settings': {
    kind: 'excluded',
    aiTables: ['planned_meals', 'user_daily_meals', 'user_profiles'],
    aiColumns: { user_profiles: ['nickname'] },
    reason: `食事の表 (planned_meals・user_daily_meals) は「食事の記録を CSV で書き出す」を押したときに /api/export/meals で取ってファイルに保存するだけで、画面に出さない。user_profiles は ${MFA_PATH_TABLE_REASON}`,
  },
  '/settings/security/mfa': { kind: 'excluded', aiTables: ['user_profiles'], aiColumns: { user_profiles: ['nickname'] }, reason: MFA_PATH_TABLE_REASON },
  '/settings/security/mfa/recover': {
    kind: 'excluded',
    aiTables: ['user_profiles'],
    aiColumns: { user_profiles: ['nickname'] },
    reason: MFA_PATH_TABLE_REASON,
  },
  '/settings/security/mfa/setup': {
    kind: 'excluded',
    aiTables: ['user_profiles'],
    aiColumns: { user_profiles: ['nickname'] },
    reason: MFA_PATH_TABLE_REASON,
  },
  '/settings/security/mfa/verify': {
    kind: 'excluded',
    aiTables: ['user_profiles'],
    aiColumns: { user_profiles: ['nickname'] },
    reason: MFA_PATH_TABLE_REASON,
  },
};

/**
 * 受け手の描画のテスト (expectRefetchReadsCoverMount を呼ぶテスト) が vi.mock で消す、読み取りのある src の部品・hook
 * (リポジトリの根からのパス → 消してよい理由)。消すと、その読み取りは開いたときの読み取りにも取り直しにも出ないので、
 * 取り直しの抜けが見えなくなる (#2195 V1 の R5: 献立表のプロフィールの帯を消すモックが、帯の読み取りの抜けを隠した)。
 * tests/ai-consultation-refetch-coverage-2195.test.ts が、描画のテストの vi.mock の先を構文木でたどり、
 *   - 読み取りのある部品を消すなら、ここに理由があること
 *   - ここに載せた部品は AI が書く表を読まないこと (AI が書く表を読む部品は消さずに描く)
 *   - ここに載せた部品を今も消していて、今も読み取りがあること (古い行を残さない)
 * を確かめる。描画のテストのログアウト (getUser が user: null を返すモック) は、利用者で絞った読み取りを隠すので使わない (同じテストが確かめる)
 */
export const AI_CONSULTATION_RENDER_TEST_MOCKED_READERS: Readonly<Record<string, string>> = {
  'src/hooks/useAiConsent.tsx':
    '外国の AI 事業者へのデータ提供の同意の状況 (GET /api/ai/consent) を開いたときに先に読む hook。同意は AI 相談が書かない表で、取り直しの検査は同意の画面を出さずに済むよう同意済みを返すモックにする',
};
