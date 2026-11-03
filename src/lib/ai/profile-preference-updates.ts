/**
 * AI 相談の提案の実行のプロフィールの更新 (update_profile_preferences) の値の検査 (#2183 Z2)
 *
 * 問題:
 *   以前は許す欄 (列の名前) の一覧で欄だけを絞り、値は検査せずに user_profiles へ update していた。
 *   time の列 (wake_time / sleep_time) には DB が受ける '24:00' や小数の秒つきの時刻が入りうる。GET の値をプロフィールの画面が
 *   そのまま PUT /api/profile に戻すと、PUT の検査 (USER_PROFILE_TIME_OF_DAY_PATTERN) が 400 で拒み、時刻の欄だけでなく
 *   全部の欄が保存できなくなる。ほかの欄も、列の型に合わない値は DB が拒み、更新の失敗になっていた。
 *
 * 決まり:
 *   - 許す欄は以前の一覧と同じ (広げない。AI_PROFILE_PREFERENCE_FIELD_NAMES のキー)。一覧に無い欄は今までどおり黙って落とす
 *   - 値の検査は PUT と同じ欄なら PUT の型 (USER_PROFILE_UPDATE_FIELDS)。PUT に無い欄 (exercise_types) は POST の型
 *     (USER_PROFILE_POST_FIELDS) を使う。列の名前 (snake_case) から欄 (camelCase) への対応は
 *     tests/ai-profile-preference-updates-2183.test.ts が lib/converter.ts の fromUserProfile と突き合わせる
 *   - 1 つでも型に合わない欄があれば、どの欄も書かない (失敗の文を返す)。失敗の文は「日本語の名前 (列の名前)」の形の日本語の固定の文
 */
import {
  PG_INTEGER_MAX,
  PG_INTEGER_MIN,
  USER_PROFILE_POST_FIELDS,
  USER_PROFILE_UPDATE_FIELDS,
  userProfileFieldSchema,
  type UserProfileColumnKind,
  type UserProfileUpdateFieldSpec,
} from '@/lib/profile-update-schema';
import { CALENDAR_DATE_REQUIREMENT_JA } from '@/lib/api/user-api-error-messages';

/** AI に書き換えを許さない欄 (許す欄の一覧に入れない。入れても落とす) */
export const AI_PROFILE_FORBIDDEN_FIELDS: readonly string[] = ['email', 'avatar_url', 'is_banned', 'role', 'auth_provider'];

/**
 * AI が書き換えてよいプロフィールの欄 (user_profiles の列の名前) → 失敗の文に出す日本語の名前。
 * AI が送るキーで引くので、プロトタイプのキー ('constructor' など) に当たらないよう Map で持つ
 */
export const AI_PROFILE_PREFERENCE_FIELD_NAMES: ReadonlyMap<string, string> = new Map([
  ['nickname', '名前'],
  ['age', '年齢'],
  ['gender', '性別'],
  ['height', '身長'],
  ['weight', '体重'],
  ['target_weight', '目標の体重'],
  ['body_fat_percentage', '体脂肪率'],
  ['target_body_fat', '目標の体脂肪率'],
  ['muscle_mass', '筋肉量'],
  ['health_conditions', '健康の状態'],
  ['medications', '服用中の薬'],
  ['fitness_goals', '体づくりの目標'],
  ['sleep_quality', '睡眠の質'],
  ['stress_level', 'ストレスの度合い'],
  ['bowel_movement', 'お通じ'],
  ['skin_condition', '肌の状態'],
  ['cold_sensitivity', '冷えやすさ'],
  ['swelling_prone', 'むくみやすさ'],
  ['occupation', '職業'],
  ['industry', '業種'],
  ['work_style', '働き方'],
  ['desk_hours_per_day', '1 日のデスクワークの時間'],
  ['overtime_frequency', '残業の頻度'],
  ['business_trip_frequency', '出張の頻度'],
  ['entertainment_frequency', '会食の頻度'],
  ['weekly_exercise_minutes', '1 週間の運動の時間'],
  ['exercise_types', '運動の種類'],
  ['diet_style', '食事のスタイル'],
  ['religious_restrictions', '宗教上の食事の制限'],
  ['diet_flags', '食事の条件'],
  ['cuisine_preferences', '好きな料理のジャンル'],
  ['taste_preferences', '味の好み'],
  ['favorite_ingredients', '好きな食材'],
  ['favorite_dishes', '好きな料理'],
  ['cooking_experience', '料理の経験'],
  ['specialty_cuisines', '得意な料理のジャンル'],
  ['disliked_cooking', '苦手な調理'],
  ['weekday_cooking_minutes', '平日の調理の時間'],
  ['weekend_cooking_minutes', '休日の調理の時間'],
  ['meal_prep_ok', '作り置き'],
  ['kitchen_appliances', '調理の器具'],
  ['wake_time', '起床の時刻'],
  ['sleep_time', '就寝の時刻'],
  ['meal_times', '食事の時刻'],
  ['snacking_habit', '間食の習慣'],
  ['alcohol_frequency', '飲酒の頻度'],
  ['smoking', '喫煙'],
  ['caffeine_intake', 'カフェインの摂取'],
  ['daily_water_ml', '1 日の水分の量'],
  ['family_size', '家族の人数'],
  ['has_children', '子どもの有無'],
  ['children_ages', '子どもの年齢'],
  ['has_elderly', '高齢の家族の有無'],
  ['weekly_food_budget', '1 週間の食費'],
  ['shopping_frequency', '買い物の頻度'],
  ['preferred_stores', 'よく使うお店'],
  ['online_grocery', 'ネットスーパーの利用'],
  ['organic_preference', 'オーガニックの好み'],
  ['hobbies', '趣味'],
  ['weekend_activity', '休日の過ごし方'],
  ['outdoor_activities', '屋外の活動'],
]);

/** 列の名前 (snake_case) → 欄の名前 (camelCase)。fromUserProfile の対応と同じ形 (テストが突き合わせる) */
export function profileFieldOfColumn(column: string): string {
  return column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * 列の値の型 (PUT と同じ欄なら USER_PROFILE_UPDATE_FIELDS、PUT に無い欄は USER_PROFILE_POST_FIELDS)。
 * 許す欄でないとき・型が見つからないときは undefined (書かない)
 */
export function aiProfilePreferenceSpecOf(column: string): UserProfileUpdateFieldSpec | undefined {
  if (!AI_PROFILE_PREFERENCE_FIELD_NAMES.has(column) || AI_PROFILE_FORBIDDEN_FIELDS.includes(column)) return undefined;
  const field = profileFieldOfColumn(column);
  if (Object.prototype.hasOwnProperty.call(USER_PROFILE_UPDATE_FIELDS, field)) return USER_PROFILE_UPDATE_FIELDS[field];
  if (Object.prototype.hasOwnProperty.call(USER_PROFILE_POST_FIELDS, field)) {
    const post = USER_PROFILE_POST_FIELDS[field];
    return post.column === column ? post.spec : undefined;
  }
  return undefined;
}

/** 列の型ごとの、失敗の文に出す受け付ける値の形 */
const PROFILE_VALUE_FORMS: Readonly<Record<UserProfileColumnKind, string>> = {
  text: '文字列',
  date: CALENDAR_DATE_REQUIREMENT_JA,
  time: '時刻 (HH:MM か HH:MM:SS。時は 00 〜 23)',
  integer: `整数 (${PG_INTEGER_MIN} 〜 ${PG_INTEGER_MAX})`,
  numeric: '数値',
  boolean: '真偽値 (true / false)',
  textArray: '文字列の配列',
  integerArray: '整数の配列',
  jsonb: 'JSON の値',
};

/** 許す欄の「日本語の名前 (列の名前)」 */
function profileFieldLabel(column: string): string {
  return `${AI_PROFILE_PREFERENCE_FIELD_NAMES.get(column) ?? '項目'} (${column})`;
}

/** プロフィールの欄の値が、列の型に合わない */
export function aiProfilePreferenceValueMessage(column: string, spec: UserProfileUpdateFieldSpec): string {
  return `${profileFieldLabel(column)} は${PROFILE_VALUE_FORMS[spec.kind]}${spec.nullable ? 'か null' : ''}で指定してください`;
}

/** 更新の内容 (updates) がオブジェクトでない */
export const AI_PROFILE_PREFERENCE_UPDATES_NOT_OBJECT_MESSAGE = '更新する内容の指定が正しくありません';

/**
 * AI が送った更新の内容から、書いてよい欄だけを列の型で検査して取り出す。
 * 許す欄でないキーは黙って落とす。型に合わない欄が 1 つでもあれば errors に文を積む (呼び出し側は何も書かない)
 */
export function sanitizeAiProfilePreferenceUpdates(input: unknown): { data: Record<string, unknown>; errors: string[] } {
  const data: Record<string, unknown> = {};
  const errors: string[] = [];
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { data, errors: [AI_PROFILE_PREFERENCE_UPDATES_NOT_OBJECT_MESSAGE] };
  }
  for (const [column, value] of Object.entries(input)) {
    const spec = aiProfilePreferenceSpecOf(column);
    if (!spec || value === undefined) continue;
    if (userProfileFieldSchema(spec).safeParse(value).success) {
      data[column] = value;
    } else {
      errors.push(aiProfilePreferenceValueMessage(column, spec));
    }
  }
  return { data, errors };
}

/**
 * AI への指示 (AI 相談のシステムプロンプト) に書く、列の型ごとの値の書き方 (#2189 W3)。
 * 型に合わない値 (例: daily_water_ml に "2000" の文字列) を送ると、どの欄も書かずに失敗の文になる (#2183 Z2)。
 * 以前の指示には欄の名前しか無く、型を伝えていなかった
 */
const PROFILE_VALUE_PROMPT_FORMS: Readonly<Record<UserProfileColumnKind, string>> = {
  // 並びはプロンプトに書く順 (Record なので、型を足すとここに書くまで tsc が通らない)
  text: '文字列',
  date: '日付の文字列 "YYYY-MM-DD"',
  time: '時刻の文字列 "HH:MM" (時は 00 〜 23)',
  integer: '整数 (数値のまま。"2000" のような文字列は不可)',
  numeric: '数値 (数値のまま。文字列は不可)',
  boolean: '真偽値 true / false (文字列の "true" は不可)',
  textArray: '文字列の配列 (例: ["鶏肉", "トマト"])',
  integerArray: '整数の配列 (例: [3, 5])',
  // jsonb の列は型を検査しない (どの JSON の値も通る)。画面が読む形を崩さないよう、今の値と同じ形で送ってもらう
  jsonb: 'JSON の値 (オブジェクトなど。今の値と同じ形で送る)',
};

/**
 * AI が書き換えてよい欄を、列の型 (aiProfilePreferenceSpecOf の kind。手で写さない) ごとにまとめた指示の文。
 * 1 行 = 1 つの型。null を受けない欄は最後の行に並べる
 */
export function aiProfilePreferenceTypesForPrompt(): string {
  const columnsByKind = new Map<UserProfileColumnKind, string[]>();
  const notNullColumns: string[] = [];
  for (const column of AI_PROFILE_PREFERENCE_FIELD_NAMES.keys()) {
    const spec = aiProfilePreferenceSpecOf(column);
    if (!spec) continue;
    columnsByKind.set(spec.kind, [...(columnsByKind.get(spec.kind) ?? []), column]);
    if (!spec.nullable) notNullColumns.push(column);
  }
  const kinds = Object.keys(PROFILE_VALUE_PROMPT_FORMS) as UserProfileColumnKind[];
  const lines = kinds.flatMap((kind) => {
    const columns = columnsByKind.get(kind);
    return columns && columns.length > 0 ? [`  - ${PROFILE_VALUE_PROMPT_FORMS[kind]}: ${columns.join(', ')}`] : [];
  });
  if (notNullColumns.length > 0) lines.push(`  - null を送れない欄: ${notNullColumns.join(', ')}`);
  return lines.join('\n');
}
