/**
 * オンボーディングの完了 (POST /api/onboarding/complete) が答えから作って書く欄 (体づくりの目標 fitness_goals・目標の文 goal_text・
 * 週の運動の時間 weekly_exercise_minutes) を、利用者が元の質問に答えたときだけ書くための判定 (#2283 判断待ち 7 の選択 B)。
 * 答えは user_profiles.onboarding_progress.answers (web は POST /api/onboarding/progress、モバイルは質問の画面の途中保存が、
 * 答えるたびに全部の答えを書く)。
 *
 * 問題 (直す前): 完了は元の列から 3 つの欄を答えの有無に関わらず作って書いていた。元の列には DB の既定値があり
 * (栄養の目標 nutrition_goal 'maintain'・運動の日数 exercise_frequency 3・1 回の時間 exercise_duration_per_session 60)、
 * 答えずに完了した (web の welcome の「あとで設定する」・質問の途中のスキップ・resume のスキップ・モバイルの welcome) ときも
 * 体づくりの目標 ['improve_energy']・目標の文「現在の体型を維持する」・週の運動 3 × 60 = 180 を書き、完成度
 * (src/lib/profile-completeness.ts) が利用者の入れていない 3 つの欄を「入っている」と数えていた。「運動していない」と答えたときも、
 * 日数は聞かれず既定値 3 のままなので週の運動が 180 になった。
 * 元の列だけでは既定値と利用者の答えを見分けられないので、答えで見分ける。答えていない欄には触れない (前から入っていた値も消さない)。
 * 「答えた」は、答えを列に写す側 (POST /api/onboarding/progress・モバイルの途中保存) と同じく値があるか (truthy) で見る
 * (写す側が列に書かなかった答えで、既定値のままの列から作らないため)
 */

/** 運動の種類の答えのうち「運動していない」の値 (src/app/onboarding/questions/question-flow.ts・モバイルの質問の exercise_types) */
const NO_EXERCISE_TYPE = 'none';

/** 運動していないと答えたときの週の運動の時間 (分) */
const NO_EXERCISE_WEEKLY_MINUTES = 0;

/**
 * 1 回の運動の時間の列が空のときに使う時間 (分)。以前の完了の計算と同じ値
 * (列には DB の既定値 60 があり、モバイルも 60 を書くので、空になるのは列を消したときだけ)
 */
const EXERCISE_DURATION_FALLBACK_MINUTES = 30;

/** 判定に使う、プロフィールの行の列 */
export type OnboardingDerivedColumnSource = {
  onboarding_progress?: unknown;
  exercise_frequency?: number | null;
  exercise_duration_per_session?: number | null;
};

/** 完了で週の運動の時間をどうするか (write: false は列に触れない) */
export type OnboardingWeeklyExerciseDecision = { write: true; minutes: number } | { write: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** onboarding_progress ({ currentStep, answers, totalQuestions, lastUpdatedAt }) の答え。進捗が無い・形が違えば null */
function onboardingAnswersOf(progress: unknown): Record<string, unknown> | null {
  if (!isRecord(progress)) return null;
  const answers = progress.answers;
  return isRecord(answers) ? answers : null;
}

/** 栄養の目標 (nutrition_goal) に答えたか。答えていなければ、体づくりの目標と目標の文を書かない */
export function answeredOnboardingNutritionGoal(profile: OnboardingDerivedColumnSource): boolean {
  return Boolean(onboardingAnswersOf(profile.onboarding_progress)?.nutrition_goal);
}

/**
 * 完了で週の運動の時間を書くか、書くなら何分か。
 *   - 運動していない ('none') と答えた: 0 (列の既定値と同じなので、完成度には数えない)。日数の答えより先に見る
 *     (運動していないを選ぶと日数は聞かれない。前に答えた日数が答えに残っていても、運動していないを優先する)
 *   - 運動の日数に答えた: 日数 × 1 回の時間 (答えを写したあとの列の値。計算は以前と同じ)
 *   - どちらも答えていない: 書かない
 */
export function onboardingWeeklyExerciseDecision(profile: OnboardingDerivedColumnSource): OnboardingWeeklyExerciseDecision {
  const answers = onboardingAnswersOf(profile.onboarding_progress);
  if (!answers) return { write: false };
  const exerciseTypes = answers.exercise_types;
  if (Array.isArray(exerciseTypes) && exerciseTypes.includes(NO_EXERCISE_TYPE)) {
    return { write: true, minutes: NO_EXERCISE_WEEKLY_MINUTES };
  }
  if (!answers.exercise_frequency) return { write: false };
  const minutes =
    (profile.exercise_frequency || 0) * (profile.exercise_duration_per_session || EXERCISE_DURATION_FALLBACK_MINUTES);
  return { write: true, minutes };
}
