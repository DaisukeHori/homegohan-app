/**
 * PUT /api/profile の本文 (camelCase のプロフィールの更新) の型の検査 (#2166 X7)
 *
 * 問題:
 *   route は本文を lib/converter.ts の fromUserProfile で snake_case にして、そのまま user_profiles に update していた。
 *   列の型に合わない値 (show_recipe_author_name に文字列・integer の列に小数や文字列・text[] の列に文字列・
 *   NOT NULL の列に null など) は DB の書き込みで拒まれ、internalError の 500 になっていた。入力の誤りなので 400 で返す。
 *
 * 決まり:
 *   - 欄は fromUserProfile が読む欄 (camelCase) と同じ。型と null の可否は、写す先の列の型 (supabase/baseline/prod_schema.sql の
 *     user_profiles と、その後の migration の ADD COLUMN) に合わせる。ドメインの型 (types/domain.ts の UserProfile) の
 *     列挙 (性別・頻度など) は検査しない。列は text で、今ある行の値を GET → PUT で戻したときに拒まないため
 *   - 列の型との対応は tests/profile-put-input-types-2166.test.ts が DDL と突き合わせる (欄の過不足・型・null の可否)
 *   - 一覧に無い欄 (id・role・createdAt など、画面が GET の行をそのまま送り返すもの) は今までどおり検査しない (fromUserProfile が無視する)
 *   - サーバーが毎回上書きする欄 (USER_PROFILE_SERVER_MANAGED_FIELDS) も検査しない。送られても書く前に上書きされ、DB に届かないため
 *   - 失敗の本文は、同じ route の JSON として読めない本文の 400 と同じ形と文 ({ error: API_INVALID_JSON_MESSAGE })
 */
import { z } from 'zod';
import { CalendarDateSchema } from '@/lib/calendar-date-schema';

/** PostgreSQL の integer (int4) の範囲。範囲の外の数は DB が拒む (22003 numeric_value_out_of_range) */
export const PG_INTEGER_MIN = -2147483648;
export const PG_INTEGER_MAX = 2147483647;

/**
 * 写す先の列の型の種類
 *   text: JSON の文字列
 *   date: 実在する日付の YYYY-MM-DD (CalendarDateSchema。存在しない日付・書式の違う文字列は DB が拒み 500 になるため、入口で 400 にする)
 *   time: 時刻の HH:MM か HH:MM:SS (USER_PROFILE_TIME_OF_DAY_PATTERN。00〜23 時。範囲の外の時刻は DB が拒み 500 になるため)
 *   integer: integer の範囲の整数 / numeric: 有限の数
 *   boolean: true / false
 *   textArray / integerArray: 要素が文字列 / 整数の配列 (要素の null は DB の配列が受けるので通す)
 *   jsonb: どの JSON の値でもよい
 */
export type UserProfileColumnKind =
  | 'text'
  | 'date'
  | 'time'
  | 'integer'
  | 'numeric'
  | 'boolean'
  | 'textArray'
  | 'integerArray'
  | 'jsonb';

export type UserProfileUpdateFieldSpec = {
  readonly kind: UserProfileColumnKind;
  /** 列が null を受けるか (NOT NULL の列は false) */
  readonly nullable: boolean;
};

const nullableColumn = (kind: UserProfileColumnKind): UserProfileUpdateFieldSpec => ({ kind, nullable: true });
const notNullColumn = (kind: UserProfileColumnKind): UserProfileUpdateFieldSpec => ({ kind, nullable: false });

/**
 * サーバーが PUT のたびに上書きする欄 (route が profile_completeness・last_profile_update を計算して入れる)。
 * fromUserProfile は読むが、本文の値は DB に届かないので検査しない
 */
export const USER_PROFILE_SERVER_MANAGED_FIELDS = ['profileCompleteness', 'lastProfileUpdate'] as const;

/** 更新できる欄 (camelCase) → 写す先の列の型。並びは fromUserProfile と同じ */
export const USER_PROFILE_UPDATE_FIELDS: Readonly<Record<string, UserProfileUpdateFieldSpec>> = {
  // Basic fields
  nickname: notNullColumn('text'),
  age: nullableColumn('integer'),
  occupation: nullableColumn('text'),
  height: nullableColumn('numeric'),
  weight: nullableColumn('numeric'),
  ageGroup: notNullColumn('text'),
  gender: notNullColumn('text'),
  goalText: nullableColumn('text'),
  performanceModes: nullableColumn('textArray'),
  lifestyle: nullableColumn('jsonb'),
  dietFlags: nullableColumn('jsonb'),
  familySize: nullableColumn('integer'),
  cheatDayConfig: nullableColumn('jsonb'),
  servingsConfig: nullableColumn('jsonb'),
  weekStartDay: nullableColumn('text'),
  radarChartNutrients: nullableColumn('textArray'),

  // Body Info
  bodyFatPercentage: nullableColumn('numeric'),
  muscleMass: nullableColumn('numeric'),
  basalBodyTemp: nullableColumn('numeric'),

  // Goals
  targetWeight: nullableColumn('numeric'),
  targetBodyFat: nullableColumn('numeric'),
  targetDate: nullableColumn('date'),
  fitnessGoals: nullableColumn('textArray'),

  // Work & Career
  industry: nullableColumn('text'),
  workStyle: nullableColumn('text'),
  workHours: nullableColumn('jsonb'),
  overtimeFrequency: nullableColumn('text'),
  commute: nullableColumn('jsonb'),
  businessTripFrequency: nullableColumn('text'),
  entertainmentFrequency: nullableColumn('text'),
  deskHoursPerDay: nullableColumn('integer'),

  // Sports & Exercise
  sportsActivities: nullableColumn('jsonb'),
  gymMember: nullableColumn('boolean'),
  personalTrainer: nullableColumn('boolean'),
  weeklyExerciseMinutes: nullableColumn('integer'),

  // Health & Medical
  healthConditions: nullableColumn('textArray'),
  medications: nullableColumn('textArray'),
  healthCheckupResults: nullableColumn('jsonb'),
  pregnancyStatus: nullableColumn('text'),
  menopause: nullableColumn('boolean'),
  sleepQuality: nullableColumn('text'),
  stressLevel: nullableColumn('text'),
  bowelMovement: nullableColumn('text'),
  skinCondition: nullableColumn('text'),
  coldSensitivity: nullableColumn('boolean'),
  swellingProne: nullableColumn('boolean'),

  // Diet Restrictions
  dietStyle: nullableColumn('text'),
  religiousRestrictions: nullableColumn('text'),
  dislikedCookingMethods: nullableColumn('textArray'),

  // Lifestyle Rhythm
  wakeTime: nullableColumn('time'),
  sleepTime: nullableColumn('time'),
  mealTimes: nullableColumn('jsonb'),
  snackingHabit: nullableColumn('text'),
  alcoholFrequency: nullableColumn('text'),
  smoking: nullableColumn('boolean'),
  caffeineIntake: nullableColumn('text'),
  dailyWaterMl: nullableColumn('integer'),

  // Cooking Environment
  cookingExperience: nullableColumn('text'),
  specialtyCuisines: nullableColumn('textArray'),
  dislikedCooking: nullableColumn('textArray'),
  weekdayCookingMinutes: nullableColumn('integer'),
  weekendCookingMinutes: nullableColumn('integer'),
  kitchenAppliances: nullableColumn('textArray'),
  mealPrepOk: nullableColumn('boolean'),
  freezerCapacity: nullableColumn('text'),

  // Budget & Shopping
  weeklyFoodBudget: nullableColumn('integer'),
  shoppingFrequency: nullableColumn('text'),
  preferredStores: nullableColumn('textArray'),
  onlineGrocery: nullableColumn('boolean'),
  costcoMember: nullableColumn('boolean'),
  organicPreference: nullableColumn('text'),

  // Taste Preferences
  cuisinePreferences: nullableColumn('jsonb'),
  tastePreferences: nullableColumn('jsonb'),
  favoriteIngredients: nullableColumn('textArray'),
  favoriteDishes: nullableColumn('textArray'),
  texturePreferences: nullableColumn('textArray'),
  temperaturePreference: nullableColumn('text'),
  presentationImportance: nullableColumn('text'),

  // Family
  householdMembers: nullableColumn('jsonb'),
  hasChildren: nullableColumn('boolean'),
  childrenAges: nullableColumn('integerArray'),
  hasElderly: nullableColumn('boolean'),
  pets: nullableColumn('textArray'),

  // Lifestyle
  hobbies: nullableColumn('textArray'),
  weekendActivity: nullableColumn('text'),
  travelFrequency: nullableColumn('text'),
  outdoorActivities: nullableColumn('textArray'),
  snsFoodPosting: nullableColumn('boolean'),

  // Environment
  region: nullableColumn('text'),
  climateSensitivity: nullableColumn('text'),

  // Meta (profileCompleteness・lastProfileUpdate は USER_PROFILE_SERVER_MANAGED_FIELDS)
  aiLearningEnabled: nullableColumn('boolean'),
  showRecipeAuthorName: notNullColumn('boolean'),

  // Performance OS v3
  performanceProfile: nullableColumn('jsonb'),
};

/**
 * time の列が受ける本文の書式: HH:MM か HH:MM:SS (時は 00〜23)。GET の行の 'HH:MM:SS' を PUT でそのまま戻しても拒まない。
 * '25:00' のような範囲の外の時刻は DB が 22008 で拒み internalError の 500 になっていた (#2178 Y1-b)
 */
export const USER_PROFILE_TIME_OF_DAY_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

const pgInteger = z.number().int().min(PG_INTEGER_MIN).max(PG_INTEGER_MAX);

function columnValueSchema(kind: UserProfileColumnKind): z.ZodType {
  switch (kind) {
    case 'text':
      return z.string();
    case 'date':
      return CalendarDateSchema;
    case 'time':
      return z.string().regex(USER_PROFILE_TIME_OF_DAY_PATTERN);
    case 'integer':
      return pgInteger;
    case 'numeric':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'textArray':
      return z.array(z.string().nullable());
    case 'integerArray':
      return z.array(pgInteger.nullable());
    case 'jsonb':
      return z.unknown();
  }
}

function fieldSchema(spec: UserProfileUpdateFieldSpec): z.ZodType {
  const value = columnValueSchema(spec.kind);
  return (spec.nullable ? value.nullable() : value).optional();
}

/**
 * PUT /api/profile の本文のスキーマ。一覧に無い欄は検査せずに通す (z.object の既定。結果の data からは落ちるが、
 * route は検査にだけ使い、書く値は今までどおり本文から fromUserProfile で作る)
 */
export const UserProfileUpdateBodySchema = z.object(
  Object.fromEntries(
    Object.entries(USER_PROFILE_UPDATE_FIELDS).map(([field, spec]) => [field, fieldSchema(spec)]),
  ),
);

/** POST /api/profile の欄の、写す先の列と列の型 */
export type UserProfilePostFieldSpec = {
  /** 写す先の user_profiles の列 (snake_case) */
  readonly column: string;
  readonly spec: UserProfileUpdateFieldSpec;
};

/**
 * POST /api/profile が受ける欄 (camelCase) → 写す先の列と列の型 (#2178 Y1-a)。
 *   - 欄の範囲は以前の POST の写し方 (本文の欄を 1 つずつ列に写していたもの) と同じ。広げない
 *   - 列の型は PUT と同じ欄なら USER_PROFILE_UPDATE_FIELDS をそのまま使う (goal は PUT の goalText と同じ goal_text の列)。
 *     PUT に無い欄 (栄養目標・運動の欄) は写す先の列の型 (supabase/baseline/prod_schema.sql の user_profiles) に合わせる。
 *     列と型の対応は tests/profile-post-input-2178.test.ts が DDL と突き合わせる
 *   - age は age_group (年代) の計算にも使う (route が入れる)
 */
export const USER_PROFILE_POST_FIELDS: Readonly<Record<string, UserProfilePostFieldSpec>> = {
  nickname: { column: 'nickname', spec: USER_PROFILE_UPDATE_FIELDS.nickname },
  gender: { column: 'gender', spec: USER_PROFILE_UPDATE_FIELDS.gender },
  lifestyle: { column: 'lifestyle', spec: USER_PROFILE_UPDATE_FIELDS.lifestyle },
  goal: { column: 'goal_text', spec: USER_PROFILE_UPDATE_FIELDS.goalText },
  age: { column: 'age', spec: USER_PROFILE_UPDATE_FIELDS.age },
  occupation: { column: 'occupation', spec: USER_PROFILE_UPDATE_FIELDS.occupation },
  height: { column: 'height', spec: USER_PROFILE_UPDATE_FIELDS.height },
  weight: { column: 'weight', spec: USER_PROFILE_UPDATE_FIELDS.weight },

  // 栄養目標・運動関連 (PUT に無い欄)
  nutritionGoal: { column: 'nutrition_goal', spec: nullableColumn('text') },
  weightChangeRate: { column: 'weight_change_rate', spec: nullableColumn('text') },
  exerciseTypes: { column: 'exercise_types', spec: nullableColumn('textArray') },
  exerciseFrequency: { column: 'exercise_frequency', spec: nullableColumn('integer') },
  exerciseIntensity: { column: 'exercise_intensity', spec: nullableColumn('text') },
  exerciseDurationPerSession: { column: 'exercise_duration_per_session', spec: nullableColumn('integer') },

  workStyle: { column: 'work_style', spec: USER_PROFILE_UPDATE_FIELDS.workStyle },
  healthConditions: { column: 'health_conditions', spec: USER_PROFILE_UPDATE_FIELDS.healthConditions },
  medications: { column: 'medications', spec: USER_PROFILE_UPDATE_FIELDS.medications },
  pregnancyStatus: { column: 'pregnancy_status', spec: USER_PROFILE_UPDATE_FIELDS.pregnancyStatus },
  fitnessGoals: { column: 'fitness_goals', spec: USER_PROFILE_UPDATE_FIELDS.fitnessGoals },
  dietFlags: { column: 'diet_flags', spec: USER_PROFILE_UPDATE_FIELDS.dietFlags },
  cookingExperience: { column: 'cooking_experience', spec: USER_PROFILE_UPDATE_FIELDS.cookingExperience },
  weekdayCookingMinutes: { column: 'weekday_cooking_minutes', spec: USER_PROFILE_UPDATE_FIELDS.weekdayCookingMinutes },
  cuisinePreferences: { column: 'cuisine_preferences', spec: USER_PROFILE_UPDATE_FIELDS.cuisinePreferences },
  familySize: { column: 'family_size', spec: USER_PROFILE_UPDATE_FIELDS.familySize },
  servingsConfig: { column: 'servings_config', spec: USER_PROFILE_UPDATE_FIELDS.servingsConfig },
  radarChartNutrients: { column: 'radar_chart_nutrients', spec: USER_PROFILE_UPDATE_FIELDS.radarChartNutrients },
};

/**
 * POST /api/profile の本文のスキーマ。一覧に無い欄は PUT と同じく検査せずに通す (route は一覧の欄だけを列に写す)
 */
export const UserProfilePostBodySchema = z.object(
  Object.fromEntries(
    Object.entries(USER_PROFILE_POST_FIELDS).map(([field, { spec }]) => [field, fieldSchema(spec)]),
  ),
);
