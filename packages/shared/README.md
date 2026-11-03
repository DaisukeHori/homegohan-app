# @homegohan/shared

Web / Mobile 共通の **純粋ロジック** パッケージ。
DOM、React Native、Supabase など、実行環境に依存するコードは含まない。

## 境界定義

| カテゴリ | 内容 | 例 |
|--------|------|-----|
| 型 | ドメイン定数型 / DB 型 | `DishRole`, `MealType`, `Tables<"users">` |
| 定数 | 表示ラベル・フェーズ定義・状態色 | `MEAL_LABELS`, `PROGRESS_PHASES`, `NUTRIENT_DEFINITIONS`, `STATUS_COLOR_TOKENS` |
| util | 純粋関数（副作用なし） | `formatLocalDate`, `todayLocal`, `getDishConfig` |
| 栄養プランナー | PFC 計算・目標予測 | `deriveMacroTargets`, `estimateGoalProjection` |
| Supabase 型 | テーブル / 列の TS 型 | `Database`, `Tables<T>`, `TablesInsert<T>` |

## 含めないもの

- HTTP client・fetch ラッパー → `@homegohan/core`
- Supabase client → `@homegohan/core`
- ストレージ抽象 (localStorage / AsyncStorage) → 各プラットフォームの実装
- UI コンポーネント → 各プラットフォームの `src/components`

## インポート方法

```ts
import { formatLocalDate, getDishConfig, MEAL_LABELS } from '@homegohan/shared';
import type { Tables, TablesInsert } from '@homegohan/shared';

type User = Tables<"user_profiles">;
type NewMeal = TablesInsert<"planned_meals">;
```

## モジュール一覧

| ファイル | エクスポート |
|---------|------------|
| `date-utils.ts` | `formatLocalDate`, `todayLocal`, `parseLocalDate`, `addDays` |
| `nutrition-planner.ts` | `deriveMacroTargets`, `estimateGoalProjection` |
| `dish-roles.ts` | `DishRole`, `DishConfig`, `getDishConfig` |
| `meal-types.ts` | `MealType`, `MEAL_LABELS`, `MEAL_EMOJIS`, `MEAL_ORDER`, `isMealType` (食事の区分の正本。Web・モバイルは 5 値を手で書かずここから導く。#1446。区分ごとの絵文字も Web・モバイル共通の見た目としてここに置く。#1665) |
| `mode-config.ts` | `ModeKey`, `ModeConfig`, `MODE_CONFIG` |
| `nutrition-constants.ts` | `NUTRIENT_DEFINITIONS`, `getNutrientDefinition`, `calculateDriPercentage` |
| `theme-labels.ts` | `THEME_LABELS_REQUEST`, `AI_CONDITIONS` |
| `progress-phases.ts` | `PROGRESS_PHASES`, `ULTIMATE_PROGRESS_PHASES`, `SHOPPING_LIST_PHASES` |
| `design-tokens.ts` | `STATUS_COLOR_TOKENS`, `StatusColorTokenKey` (状態色。塗り用の `success` / `warning` / `error` / `danger` と各 `*Light`、文字用の `successText` / `warningText` / `dangerText`。文字用は WCAG AA 4.5:1 以上。Web の home・health・pantry とモバイルの `colors.ts` が import する。#590) |
| `health-blood-test-reference.ts` | `ALL_METRIC_DEFS`, `BLOOD_METRIC_DEFS`, `BODY_METRIC_DEFS`, `getRangeForSex`, `formatRangeText`, `evaluateStatus`, `getStatusLabel`, `getMetricLabel`, `getMetricUnit`, `BiologicalSex`, `MetricKey`, `MetricStatus` (健診・血液検査の値の基準値 (性別依存) と判定。Web の健診の詳細・血液検査の画面が使う (モバイルの健診の詳細の画面も使っていたが、#1598 で消した)。Web の `src/lib/health-blood-test-reference.ts` はここを読み直すだけ。#1055 / #1049) |
| `profile-name.ts` | `PROFILE_NAME_PLACEHOLDER`, `normalizeName`, `normalizeProfileName` (プロフィールの名前の仮置き `'Guest'` (前後の空白を除いて厳密一致) と空・空白だけを「名前が無い」とする判定。Web の `src/lib/profile-name.ts` はここを読み直すだけ。モバイルの再開・ハンズオンツアーの画面 (プロフィールと運営の一覧の画面も使っていたが、#1598 で消した) と `GET /api/onboarding/status`、名前を返す・宛名に使う API (レシピの作者名・問い合わせ者名・家族や組織のメールの宛名など) が使う。Edge Functions は packages/shared を読めないので `supabase/functions/_shared/profile-name.ts` に同じ規則の写しがあり、一致は `tests/edge-profile-name-sync.test.ts` が確かめる。#1611 / #1635 / #1649) |
| `handson-tour-nickname.ts` | `HANDSON_TOUR_NICKNAME_FALLBACK`, `HANDSON_TOUR_NICKNAME_MAX_LENGTH`, `handsonTourNickname` (ハンズオンツアーの呼びかけ ({nickname} さん) に出す名前。`normalizeProfileName` で名前が無い (仮置きの `'Guest'`・空・空白だけ) ときは `'あなた'`、30 文字を超えたら切って「…」。Web の 5 画面とモバイルの 5 画面が使う。#1635 / #1649) |
| `consultation-action-outcome.ts` | `AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE`, `ConsultationActionOutcome`, `consultationActionFailureMessageOf`, `consultationActionExecutedMessageOf`, `consultationActionOutcomeOf`, `CONSULTATION_ACTION_LABELS`, `CONSULTATION_ACTION_LABEL_FALLBACK`, `consultationActionLabelOf`, `consultationAutoActionOutcomeOf`, `ConsultationAutoActionOutcome` (AI 相談の提案の実行の結果をチャットに出す一文 (成功『✅ …を実行しました！』・失敗の文) と、提案の種類の名前。Web の `src/lib/ai/consultation-action-outcome.ts` は判定を読み直すだけで、Web の AI 相談とモバイルの AI 相談のシートが同じ判定を使う。種類の名前の表の鍵は実行の側の case と一致させる (`tests/consultation-action-labels-shared-2189.test.ts`)。#2183 / #2189) |
| `database.types.ts` | `Database`, `Tables`, `TablesInsert`, `TablesUpdate`, `Enums`, `CompositeTypes`, `DatabaseConstants` |

## Supabase 型の再生成

`src/database.types.ts` は、リポジトリの `src/types/database.types.ts` と同じ内容の写し。手動編集は禁止。
本番には接続せずに作る (#1495):

1. ローカルの Supabase をベースライン方式で組み立てる (`bash scripts/supabase-local.sh start` → `reset`)。
   本番スキーマのスナップショット (`supabase/baseline/`) を当て、そのあとにベースラインより新しい migration だけを当てる
2. `npx supabase@2.62.10 gen types typescript --local --schema public --workdir .supabase-local` の出力で
   `src/types/database.types.ts` を置き換える (枠 n (`LOCAL_CI_SLOT=n`) で組み立てたときの作業ディレクトリは `.supabase-local-s<n>`)。
   `--local` は `__InternalSupabase` の `PostgrestVersion` を出さないので、既存の値を残す
3. 同じ内容を `packages/shared/src/database.types.ts` に写す

`tests/database-types-migrations-contract.test.ts` が、migration と型ファイルの突き合わせと、写しの一致を確かめる。
