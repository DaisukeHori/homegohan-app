// types/domain.ts

export type ISODateTimeString = string;
export type ISODateString = string;

// --- Enum Types ---

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'midnight_snack';

export type AgeGroup =
  | 'under_18'
  | 'age_19_29'
  | 'age_30_39'
  | 'age_40_49'
  | 'age_50_plus';

export type Gender = 'male' | 'female' | 'other' | 'unspecified';

export type PerformanceMode =
  | 'sports'
  | 'physical_work'
  | 'knowledge_work'
  | 'study'
  | 'creative'
  | 'shift_work'
  | 'family_support'
  | 'longevity';

export type UserRole = 'user' | 'admin' | 'org_admin';

// --- Fitness Goals ---
export type FitnessGoal =
  | 'lose_weight'
  | 'gain_weight'
  | 'build_muscle'
  | 'improve_energy'
  | 'improve_skin'
  | 'gut_health'
  | 'anti_aging'
  | 'immunity'
  | 'focus';

// --- Work Style ---
export type WorkStyle = 'fulltime' | 'parttime' | 'freelance' | 'remote' | 'shift' | 'student' | 'homemaker' | 'retired';

// --- Cooking Experience ---
export type CookingExperience = 'beginner' | 'intermediate' | 'advanced';

// --- Diet Style ---
export type DietStyle = 'normal' | 'vegetarian' | 'vegan' | 'pescatarian' | 'flexitarian' | 'gluten_free' | 'low_fodmap' | 'keto';

// --- Frequency Types ---
export type Frequency = 'never' | 'rarely' | 'sometimes' | 'often' | 'daily';

// --- Shopping Frequency (V4) ---
export type ShoppingFrequency = 'daily' | '2-3_weekly' | 'weekly' | 'biweekly';

// --- Quality Level ---
export type QualityLevel = 'good' | 'average' | 'poor';

// --- Stress Level ---
export type StressLevel = 'low' | 'medium' | 'high';

// --- User Profile & Settings ---

export interface LifestyleInfo {
  workStyle: 'desk' | 'stand' | 'physical' | 'shift';
  exerciseLevel: 'none' | 'light_1_2' | 'regular_3plus';
  notes?: string | null;
}

export interface DietFlags {
  allergies?: string[];
  restrictions?: string[];
  dislikes?: string[];
}

export interface CheatDayConfig {
  enabled: boolean;
  frequency: 'weekly' | 'biweekly';
  dayOfWeek: string; // 'Sunday', etc.
}

// --- Week Start Day (週の開始曜日) ---
export type WeekStartDay = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

// --- Servings Config (曜日別・食事別人数設定) ---
export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export interface MealServings {
  breakfast?: number;
  lunch?: number;
  dinner?: number;
}

export interface ServingsConfig {
  default: number;
  byDayMeal: {
    [key in DayOfWeek]?: MealServings;
  };
}

// --- Extended Profile Types ---

export interface WorkHours {
  start: string; // "09:00"
  end: string;   // "18:00"
}

export interface CommuteInfo {
  method: 'walk' | 'bike' | 'train' | 'car' | 'bus' | 'none';
  minutes: number;
}

export interface SportActivity {
  name: string;
  frequency: 'daily' | 'weekly_3plus' | 'weekly_1_2' | 'monthly' | 'rarely';
  intensity: 'light' | 'moderate' | 'intense';
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'varies';
  purpose: 'hobby' | 'competition' | 'health';
}

export interface HealthCheckupResults {
  bloodPressure?: { systolic: number; diastolic: number };
  hba1c?: number;
  cholesterol?: { total: number; ldl: number; hdl: number };
  triglycerides?: number;
  uricAcid?: number;
  gammaGtp?: number;
  date?: ISODateString;
}

export interface MealTimes {
  breakfast: string; // "07:30"
  lunch: string;     // "12:00"
  dinner: string;    // "19:00"
}

export interface CuisinePreferences {
  japanese: number;  // 1-5
  western: number;
  chinese: number;
  italian: number;
  french: number;
  ethnic: number;
  korean: number;
  mexican: number;
}

export interface TastePreferences {
  spicy: number;   // 1-5
  sweet: number;
  sour: number;
  salty: number;
  umami: number;
}

export interface HouseholdMember {
  relation: 'spouse' | 'child' | 'parent' | 'sibling' | 'other';
  age: number;
  allergies?: string[];
  preferences?: string[];
}

// --- Main User Profile (Extended) ---

export interface UserProfile {
  id: string;
  nickname: string;
  age: number | null;
  occupation: string | null;
  height: number | null;
  weight: number | null;
  ageGroup: AgeGroup;
  gender: Gender;
  goalText: string | null;
  performanceModes: PerformanceMode[];
  lifestyle: LifestyleInfo | null;
  dietFlags: DietFlags | null;
  
  // Extended Basic
  role: UserRole;
  organizationId: string | null;
  department: string | null;
  familySize: number;
  cheatDayConfig: CheatDayConfig | null;
  servingsConfig: ServingsConfig | null;
  weekStartDay: WeekStartDay;
  radarChartNutrients: string[] | null; // レーダーチャートに表示する栄養素キーの配列

  // === NEW: Body Info ===
  bodyFatPercentage: number | null;
  muscleMass: number | null;
  basalBodyTemp: number | null;

  // === NEW: Goals ===
  targetWeight: number | null;
  targetBodyFat: number | null;
  targetDate: ISODateString | null;
  fitnessGoals: FitnessGoal[];

  // === NEW: Work & Career ===
  industry: string | null;
  workStyle: WorkStyle | null;
  workHours: WorkHours | null;
  overtimeFrequency: Frequency | null;
  commute: CommuteInfo | null;
  businessTripFrequency: Frequency | null;
  entertainmentFrequency: Frequency | null;
  deskHoursPerDay: number | null;

  // === NEW: Sports & Exercise ===
  sportsActivities: SportActivity[];
  gymMember: boolean;
  personalTrainer: boolean;
  weeklyExerciseMinutes: number;

  // === NEW: Health & Medical ===
  healthConditions: string[];
  medications: string[];
  healthCheckupResults: HealthCheckupResults | null;
  pregnancyStatus: 'none' | 'pregnant' | 'nursing' | null;
  menopause: boolean;
  sleepQuality: QualityLevel | null;
  stressLevel: StressLevel | null;
  bowelMovement: 'good' | 'constipation' | 'diarrhea' | 'irregular' | null;
  skinCondition: 'good' | 'acne' | 'dry' | 'oily' | null;
  coldSensitivity: boolean;
  swellingProne: boolean;

  // === NEW: Diet Restrictions ===
  dietStyle: DietStyle;
  religiousRestrictions: 'none' | 'halal' | 'kosher' | 'buddhist' | null;
  dislikedCookingMethods: string[];

  // === NEW: Lifestyle Rhythm ===
  wakeTime: string | null;  // "07:00"
  sleepTime: string | null; // "23:00"
  mealTimes: MealTimes | null;
  snackingHabit: Frequency | null;
  alcoholFrequency: Frequency | null;
  smoking: boolean;
  caffeineIntake: 'none' | 'light' | 'moderate' | 'heavy' | null;
  dailyWaterMl: number | null;

  // === NEW: Cooking Environment ===
  cookingExperience: CookingExperience;
  specialtyCuisines: string[];
  dislikedCooking: string[];
  weekdayCookingMinutes: number;
  weekendCookingMinutes: number;
  kitchenAppliances: string[];
  mealPrepOk: boolean;
  freezerCapacity: 'small' | 'medium' | 'large' | null;

  // === NEW: Budget & Shopping ===
  weeklyFoodBudget: number | null;
  shoppingFrequency: ShoppingFrequency | null;
  preferredStores: string[];
  onlineGrocery: boolean;
  costcoMember: boolean;
  organicPreference: 'none' | 'sometimes' | 'always' | null;

  // === NEW: Taste Preferences ===
  cuisinePreferences: CuisinePreferences | null;
  tastePreferences: TastePreferences | null;
  favoriteIngredients: string[];
  favoriteDishes: string[];
  texturePreferences: string[];
  temperaturePreference: 'hot' | 'cold' | 'both' | null;
  presentationImportance: 'low' | 'medium' | 'high' | null;

  // === NEW: Family ===
  householdMembers: HouseholdMember[];
  hasChildren: boolean;
  childrenAges: number[];
  hasElderly: boolean;
  pets: string[];

  // === NEW: Lifestyle ===
  hobbies: string[];
  weekendActivity: 'active' | 'relaxed' | 'mixed' | null;
  travelFrequency: Frequency | null;
  outdoorActivities: string[];
  snsFoodPosting: boolean;

  // === NEW: Environment ===
  region: string | null;
  climateSensitivity: 'hot' | 'cold' | 'both' | null;

  // === NEW: Meta ===
  profileCompleteness: number;
  lastProfileUpdate: ISODateTimeString | null;
  aiLearningEnabled: boolean;

  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

// --- Meals ---

export interface Meal {
  id: string;
  userId: string;
  eatenAt: ISODateTimeString;
  mealType: MealType;
  photoUrl: string | null;
  memo: string | null;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  
  // Joined Data (Optional)
  nutrition?: MealNutritionEstimate;
  feedback?: MealAiFeedback;
}

export interface MealNutritionEstimate {
  id: string;
  mealId: string;
  energyKcal: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbsG: number | null;
  vegScore: number | null; // 0-5
  qualityTags: string[];
  rawJson: any;
  createdAt: ISODateTimeString;
}

export interface MealAiFeedback {
  id: string;
  mealId: string;
  feedbackText: string;
  adviceText: string | null;
  modelName: string;
  createdAt: ISODateTimeString;
}

// --- Weekly Menu (AI Request Log) ---

export type WeeklyMenuRequestStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'confirmed';

export interface WeeklyMenuRequest {
  id: string;
  userId: string;
  startDate: ISODateString;
  status: WeeklyMenuRequestStatus;
  prompt: string;
  resultJson: WeeklyMenuResult | null;
  errorMessage: string | null;
  
  // Request constraints
  constraints: WeeklyMenuConstraints | null;
  inventoryImageUrl: string | null;
  detectedIngredients: string[] | null;
  predictionResult: any | null;

  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  
  // V3+ fields
  mode: MenuRequestMode | null;
  targetDate: ISODateString | null;
  targetMealType: MealType | null;
  targetMealId: string | null;
  progress: MenuGenerationProgress | null;
  generatedData: any | null;
  currentStep: number | null;
  
  // V4 fields
  targetSlots: TargetSlot[] | null;
}

// --- V4 Types ---

export type MenuRequestMode = 'weekly' | 'single' | 'regenerate' | 'v4';

// V4 TargetSlot: 生成対象のスロット
export interface TargetSlot {
  date: ISODateString;
  mealType: MealType;
  plannedMealId?: string; // 既存スロットの上書き時のみ指定
}

// V4 Menu Generation Progress
export interface MenuGenerationProgress {
  currentStep: number;
  totalSteps: number;
  currentDay?: number;
  totalDays?: number;
  message?: string;
  completedSlots?: number;
  totalSlots?: number;
}

// V4 Request body for /api/ai/menu/v4/generate
export interface GenerateMenuV4Request {
  targetSlots: TargetSlot[];
  existingMenus?: ExistingMenuContext[];
  fridgeItems?: FridgeItemContext[];
  note?: string;
  constraints?: MenuGenerationConstraints;
  familySize?: number;
  userProfile?: Partial<UserProfile>;
  seasonalContext?: SeasonalContext;
}

// 既存献立のコンテキスト
export interface ExistingMenuContext {
  date: ISODateString;
  mealType: MealType;
  dishName: string;
  status: 'completed' | 'ai' | 'manual' | 'skip';
  isPast: boolean;
}

// 冷蔵庫食材のコンテキスト
export interface FridgeItemContext {
  name: string;
  expirationDate?: ISODateString;
  quantity?: string;
}

// 生成制約
export interface MenuGenerationConstraints {
  useFridgeFirst?: boolean;
  quickMeals?: boolean;
  japaneseStyle?: boolean;
  healthy?: boolean;
  budgetFriendly?: boolean;
  familyFriendly?: boolean;
}

// 季節コンテキスト
export interface SeasonalContext {
  month: number;
  seasonalIngredients: {
    vegetables: string[];
    fish: string[];
    fruits: string[];
  };
  events: SeasonalEvent[];
}

// 季節イベント
export interface SeasonalEvent {
  name: string;
  date: string; // "MM-DD" or "variable"
  dishes: string[];
  ingredients: string[];
  note?: string;
}

export interface WeeklyMenuConstraints {
  ingredients?: string[];
  expiringSoon?: string[];
  cookingTime?: { weekday: number; weekend: number };
  themes?: string[];
  familySize?: number;
  cheatDay?: string;
}

export interface WeeklyMenuResult {
  days: WeeklyMenuDay[];
  shoppingList: ShoppingCategory[];
  projectedImpact: ProjectedImpact;
}

export interface WeeklyMenuDay {
  date: ISODateString;
  dayOfWeek: string;
  isCheatDay: boolean;
  meals: DailyMealSet[];
  nutritionalAdvice: string;
}

export interface DailyMealSet {
  mealType: 'breakfast' | 'lunch' | 'dinner';
  dishes: Dish[];
  isSkipped?: boolean;
  imageUrl?: string;
}

export interface Dish {
  name: string;
  role?: string;
  description?: string;
}

export interface ShoppingCategory {
  category: string;
  items: string[];
}

export interface ProjectedImpact {
  weightChange: string;
  energyLevel: string;
  skinCondition: string;
  comment: string;
}

// --- Daily Meal (日付ベースの献立管理) ---

export interface DailyMeal {
  id: string;
  userId: string;
  dayDate: ISODateString;
  theme: string | null;
  nutritionalFocus: string | null;
  isCheatDay: boolean;
  sourceRequestId: string | null;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;

  // Joined
  meals?: PlannedMeal[];
}

// --- Shopping List (買い物リスト親テーブル) ---

export type ShoppingListStatus = 'active' | 'archived';

export interface ShoppingList {
  id: string;
  userId: string;
  title: string | null;
  startDate: ISODateString;
  endDate: ISODateString;
  status: ShoppingListStatus;
  servingsConfig: ServingsConfig | null;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;

  // Joined
  items?: ShoppingListItem[];
}

// --- Shopping List Request (非同期生成リクエスト) ---

export type ShoppingListRequestStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface ShoppingListRequestProgress {
  phase: string;
  message: string;
  percentage: number;
}

export interface ShoppingListRequest {
  id: string;
  userId: string;
  shoppingListId: string | null;
  status: ShoppingListRequestStatus;
  progress: ShoppingListRequestProgress | null;
  result: any | null;
  errorMessage: string | null;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

// --- Legacy Meal Plan Types (互換性のため残す、段階的に削除予定) ---

export type MealPlanStatus = 'draft' | 'active' | 'completed' | 'archived';

/** @deprecated Use DailyMeal instead */
export interface MealPlan {
  id: string;
  userId: string;
  title: string;
  startDate: ISODateString;
  endDate: ISODateString;
  status: MealPlanStatus;
  isActive: boolean;
  sourceRequestId: string | null;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;

  // Joined
  days?: MealPlanDay[];
  shoppingList?: ShoppingListItem[];
}

/** @deprecated Use DailyMeal instead */
export interface MealPlanDay {
  id: string;
  mealPlanId: string;
  dayDate: ISODateString;
  dayOfWeek: string | null;
  theme: string | null;
  nutritionalFocus: string | null;
  isCheatDay: boolean;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;

  // Joined
  meals?: PlannedMeal[];
}

export type MealMode = 'cook' | 'quick' | 'buy' | 'out' | 'skip' | 'ai_creative';

/**
 * DishDetail - 料理の詳細情報
 * 
 * ======================================================================
 * ⚠️ 重要: 栄養素プロパティの命名規則 ⚠️
 * ======================================================================
 * 
 * 栄養素プロパティは以下の命名規則に従っています。
 * **この規則を変更してはいけません。**
 * 
 * 【命名規則】
 *   {栄養素名}_{単位}
 *   例: calories_kcal, protein_g, vitamin_a_ug
 * 
 * 【単位の種類】
 *   - kcal: キロカロリー（エネルギー）
 *   - g:    グラム（タンパク質、脂質、炭水化物、塩分、糖質、食物繊維、脂肪酸）
 *   - mg:   ミリグラム（カリウム、カルシウム、鉄、亜鉛、コレステロール、ビタミンB群、C、E）
 *   - ug:   マイクログラム（ヨウ素、ビタミンA、B12、D、K、葉酸）
 * 
 * 【変更禁止の理由】
 *   1. DBの planned_meals.dishes (JSONB) にこの形式で保存されている
 *   2. Edge Functions (generate-weekly-menu-v3 等) がこの形式で出力している
 *   3. UI (weekly/page.tsx 等) がこの形式を参照している
 *   4. マイグレーションを行わずに変更すると、新旧データの不整合が発生する
 * 
 * 【変更が必要な場合】
 *   1. 必ずDBマイグレーションを作成し、既存データを新形式に変換する
 *   2. Edge Functions、UI、型定義を同時に更新する
 *   3. 設計書 (DESIGN.md) のマッピング規則を更新する
 * 
 * 参照: DESIGN.md「10. 栄養素プロパティ命名規則（重要）」
 * ======================================================================
 */
export interface DishDetail {
  name: string;
  role?: string; // 'main' | 'side' | 'soup' | 'rice' | 'salad' | etc.
  ingredient?: string; // 主な食材（旧形式、後方互換用）
  ingredients?: string[]; // この料理の材料リスト
  recipeSteps?: string[]; // この料理のレシピ手順
  ingredientsMd?: string; // 材料のマークダウン
  recipeStepsMd?: string; // 作り方のマークダウン
  displayOrder?: number; // 表示順序
  
  // ===== 栄養素（単位付きの統一形式）=====
  // ⚠️ 命名規則を変更しないこと！上記コメント参照
  // 基本栄養素
  calories_kcal?: number;  // エネルギー (kcal)
  protein_g?: number;      // タンパク質 (g)
  fat_g?: number;          // 脂質 (g)
  carbs_g?: number;        // 炭水化物 (g)
  
  // 塩分・糖質・食物繊維
  sodium_g?: number;       // 塩分 (g)
  sugar_g?: number;        // 糖質 (g)
  fiber_g?: number;        // 食物繊維 (g)
  fiber_soluble_g?: number;   // 水溶性食物繊維 (g)
  fiber_insoluble_g?: number; // 不溶性食物繊維 (g)
  
  // ミネラル
  potassium_mg?: number;   // カリウム (mg)
  calcium_mg?: number;     // カルシウム (mg)
  phosphorus_mg?: number;  // リン (mg)
  magnesium_mg?: number;   // マグネシウム (mg)
  iron_mg?: number;        // 鉄 (mg)
  zinc_mg?: number;        // 亜鉛 (mg)
  iodine_ug?: number;      // ヨウ素 (µg)
  cholesterol_mg?: number; // コレステロール (mg)
  
  // ビタミン
  vitamin_a_ug?: number;   // ビタミンA (µg)
  vitamin_b1_mg?: number;  // ビタミンB1 (mg)
  vitamin_b2_mg?: number;  // ビタミンB2 (mg)
  vitamin_b6_mg?: number;  // ビタミンB6 (mg)
  vitamin_b12_ug?: number; // ビタミンB12 (µg)
  vitamin_c_mg?: number;   // ビタミンC (mg)
  vitamin_d_ug?: number;   // ビタミンD (µg)
  vitamin_e_mg?: number;   // ビタミンE (mg)
  vitamin_k_ug?: number;   // ビタミンK (µg)
  folic_acid_ug?: number;  // 葉酸 (µg)
  
  // 脂肪酸
  saturated_fat_g?: number;       // 飽和脂肪酸 (g)
  monounsaturated_fat_g?: number; // 一価不飽和脂肪酸 (g)
  polyunsaturated_fat_g?: number; // 多価不飽和脂肪酸 (g)
}

// dishes は配列形式で可変数に対応
export type MealDishes = DishDetail[];

export interface PlannedMeal {
  id: string;
  dailyMealId: string;
  mealType: MealType;
  dishName: string;
  recipeUrl: string | null;
  imageUrl: string | null;
  description: string | null;
  ingredients: string[];
  recipeSteps: string[] | null; // レシピの作り方手順
  
  // 基本栄養素
  caloriesKcal: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbsG: number | null;
  
  // 拡張栄養素
  sodiumG: number | null;
  aminoAcidG: number | null;
  sugarG: number | null;
  fiberG: number | null;
  fiberSolubleG: number | null;
  fiberInsolubleG: number | null;
  potassiumMg: number | null;
  calciumMg: number | null;
  magnesiumMg: number | null;
  phosphorusMg: number | null;
  ironMg: number | null;
  zincMg: number | null;
  iodineUg: number | null;
  cholesterolMg: number | null;
  vitaminB1Mg: number | null;
  vitaminB2Mg: number | null;
  vitaminCMg: number | null;
  vitaminB6Mg: number | null;
  vitaminB12Ug: number | null;
  folicAcidUg: number | null;
  vitaminAUg: number | null;
  vitaminDUg: number | null;
  vitaminKUg: number | null;
  vitaminEMg: number | null;
  saturatedFatG: number | null;
  monounsaturatedFatG: number | null;
  polyunsaturatedFatG: number | null;
  
  isCompleted: boolean;
  completedAt: ISODateTimeString | null;
  actualMealId: string | null;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  
  // Extended fields for mode and dishes
  mode: MealMode;
  dishes: MealDishes | null;
  isSimple: boolean;
  cookingTimeMinutes: number | null;
  
  // Additional fields (migrated from meals/meal_nutrition_estimates)
  memo: string | null;
  vegScore: number | null;
  qualityTags: string[] | null;
  
  // Display order for reordering meals
  displayOrder: number;
  
  // 生成中フラグ
  isGenerating: boolean;
}

// 栄養素の詳細型
export interface NutritionDetails {
  caloriesKcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  sodiumG: number;
  aminoAcidG: number;
  sugarG: number;
  fiberG: number;
  fiberSolubleG: number;
  fiberInsolubleG: number;
  potassiumMg: number;
  calciumMg: number;
  magnesiumMg: number;
  phosphorusMg: number;
  ironMg: number;
  zincMg: number;
  iodineUg: number;
  cholesterolMg: number;
  vitaminB1Mg: number;
  vitaminB2Mg: number;
  vitaminCMg: number;
  vitaminB6Mg: number;
  vitaminB12Ug: number;
  folicAcidUg: number;
  vitaminAUg: number;
  vitaminDUg: number;
  vitaminKUg: number;
  vitaminEMg: number;
  saturatedFatG: number;
  monounsaturatedFatG: number;
  polyunsaturatedFatG: number;
}

// 栄養目標
export interface NutritionTargets {
  id: string;
  userId: string;
  dailyCalories: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbsG: number | null;
  sodiumG: number | null;
  sugarG: number | null;
  fiberG: number | null;
  potassiumMg: number | null;
  calciumMg: number | null;
  phosphorusMg: number | null;
  ironMg: number | null;
  zincMg: number | null;
  iodineUg: number | null;
  cholesterolMg: number | null;
  vitaminB1Mg: number | null;
  vitaminB2Mg: number | null;
  vitaminB6Mg: number | null;
  vitaminB12Ug: number | null;
  folicAcidUg: number | null;
  vitaminCMg: number | null;
  vitaminAUg: number | null;
  vitaminDUg: number | null;
  vitaminKUg: number | null;
  vitaminEMg: number | null;
  saturatedFatG: number | null;
  autoCalculate: boolean;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

// 数量バリエーション（タップ切り替え用）
export interface QuantityVariant {
  display: string;  // 表示用（"500g", "2枚(約500g)" など）
  unit: string;     // 単位（"g", "枚", "個" など）
  value: number | null; // 数値（パース可能な場合）
}

export type ShoppingListItemSource = 'manual' | 'generated';

export interface ShoppingListItem {
  id: string;
  shoppingListId: string;
  category: string;
  itemName: string;
  quantity: string | null; // 後方互換: 現在選択中の表示
  isChecked: boolean;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  
  // LLM正規化対応
  source: ShoppingListItemSource;
  normalizedName: string | null;
  quantityVariants: QuantityVariant[];
  selectedVariantIndex: number;
}

// --- Pantry & Recipes ---

export interface PantryItem {
  id: string;
  userId: string;
  name: string;
  amount: string | null;
  category: 'meat' | 'vegetable' | 'fish' | 'dairy' | 'other';
  expirationDate: ISODateString | null;
  addedAt: ISODateString;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

export interface Recipe {
  id: string;
  userId: string | null;
  name: string;
  description: string | null;
  caloriesKcal: number | null;
  cookingTimeMinutes: number | null;
  servings: number;
  imageUrl: string | null;
  ingredients: RecipeIngredient[];
  steps: string[];
  isPublic: boolean;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

export interface RecipeIngredient {
  name: string;
  amount: string;
}

// --- Organization & Stats ---

export interface Organization {
  id: string;
  name: string;
  plan: 'standard' | 'premium' | 'enterprise';
  createdAt: ISODateTimeString;
}

export interface OrgDailyStats {
  id: string;
  organizationId: string;
  date: ISODateString;
  memberCount: number;
  activeMemberCount: number;
  breakfastRate: number;
  lateNightRate: number;
  avgScore: number;
  createdAt: ISODateTimeString;
}

// --- Activity & Social ---

export interface DailyActivityLog {
  id: string;
  userId: string;
  date: ISODateString;
  steps: number | null;
  caloriesBurned: number | null;
  feeling: 'good' | 'tired' | 'stress' | 'rest' | 'normal' | 'active' | string;
  createdAt: ISODateTimeString;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  isPublic: boolean;
  publishedAt: ISODateTimeString | null;
  createdAt: ISODateTimeString;
}

// --- Badges ---

export interface Badge {
  id: string;
  code: string;
  name: string;
  description: string;
  conditionJson: any;
}

export interface UserBadge {
  userId: string;
  badgeId: string;
  obtainedAt: ISODateTimeString;
  // Joined
  badge?: Badge;
}

// --- Nutrition Calculation Types ---

export interface NutritionTarget {
  dailyCalories: number;
  protein: number;  // grams
  fat: number;      // grams
  carbs: number;    // grams
  fiber: number;    // grams
  sodium: number;   // mg
}

export interface MealConstraints {
  excludeIngredients: string[];
  excludeCookingMethods: string[];
  preferredIngredients: string[];
  maxCookingTime: { weekday: number; weekend: number };
  healthFocus: HealthFocusItem[];
  cuisineRatio: Record<string, number>;
  budget: number | null;
  familyConsiderations: string[];
}

export interface HealthFocusItem {
  condition: string;
  actions: string[];
  excludeIngredients?: string[];
  preferIngredients?: string[];
}
