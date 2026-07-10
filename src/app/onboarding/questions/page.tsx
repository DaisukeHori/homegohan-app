"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { motion, AnimatePresence } from "framer-motion";
import { QUESTIONS, pruneStaleAnswers } from "./question-flow";
import { finalizeOnboarding, parseErrorMessage, GENERIC_SAVE_ERROR_MESSAGE } from "./complete-flow";
import { addTagsFromInput } from "./tag-input";
import { NICKNAME_MAX_LENGTH, OCCUPATION_MAX_LENGTH, TAG_MAX_COUNT, AGE_MIN, AGE_MAX } from "@/schemas/onboarding";

// 曜日別人数設定のデータ
const DAYS_OF_WEEK = [
  { key: "monday", label: "月" },
  { key: "tuesday", label: "火" },
  { key: "wednesday", label: "水" },
  { key: "thursday", label: "木" },
  { key: "friday", label: "金" },
  { key: "saturday", label: "土" },
  { key: "sunday", label: "日" },
] as const;

const MEAL_TYPES = [
  { key: "breakfast", label: "朝" },
  { key: "lunch", label: "昼" },
  { key: "dinner", label: "夜" },
] as const;

type ServingsConfig = {
  default: number;
  byDayMeal: {
    [day: string]: {
      breakfast?: number;
      lunch?: number;
      dinner?: number;
    };
  };
};

function createDefaultServingsConfig(familySize: number): ServingsConfig {
  const config: ServingsConfig = {
    default: familySize,
    byDayMeal: {},
  };
  for (const day of DAYS_OF_WEEK) {
    config.byDayMeal[day.key] = {
      breakfast: familySize,
      lunch: 0,
      dinner: familySize,
    };
  }
  return config;
}

// OB-UI-02: 質問フロー（リアルタイム保存対応）
function OnboardingQuestionsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isResume = searchParams.get('resume') === 'true';
  
  const [currentStep, setCurrentStep] = useState(0);
  const [stepHistory, setStepHistory] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [inputValue, setInputValue] = useState("");
  const [selectedMulti, setSelectedMulti] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [isLoading, setIsLoading] = useState(isResume);
  const [isSaving, setIsSaving] = useState(false);
  const [isCalculating, setIsCalculating] = useState(false);
  // #1045 round-2 (Sonnet Warning): 進捗保存/完了処理が失敗したことをユーザーに提示するための状態。
  // saveError = 質問回答ごとのリアルタイム保存 (非ブロッキング) のエラー表示。
  // completionError = 最終確定 (progress→complete) の fail-closed エラー画面用。
  const [saveError, setSaveError] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const lastFinalAnswersRef = useRef<Record<string, any> | null>(null);

  // 再開時は進捗を復元
  useEffect(() => {
    if (isResume) {
      const fetchProgress = async () => {
        try {
          const res = await fetch('/api/onboarding/status');
          if (res.ok) {
            const data = await res.json();
            if (data.status === 'in_progress' && data.progress) {
              setCurrentStep(data.progress.currentStep || 0);
              setAnswers(data.progress.answers || {});
            }
          }
        } catch (error) {
          console.error('Failed to fetch progress:', error);
        } finally {
          setIsLoading(false);
        }
      };
      fetchProgress();
    }
  }, [isResume]);

  // 条件に基づいて次の質問を取得
  const getNextQuestion = (fromStep: number, ans: Record<string, any>) => {
    for (let i = fromStep + 1; i < QUESTIONS.length; i++) {
      const q = QUESTIONS[i];
      if (!q.showIf || q.showIf(ans)) {
        return i;
      }
    }
    return -1; // 終了
  };

  // 進捗計算（条件付き質問を考慮）
  const calculateTotalQuestions = (ans: Record<string, any>) => {
    let total = 0;
    for (let i = 0; i < QUESTIONS.length; i++) {
      const q = QUESTIONS[i];
      if (!q.showIf || q.showIf(ans)) {
        total++;
      }
    }
    return total;
  };

  const currentQuestion = QUESTIONS[currentStep];
  const isNumberQuestion = currentQuestion?.type === 'number';
  const currentQuestionFields = currentQuestion as Record<string, unknown>;
  const numberMin = isNumberQuestion && typeof currentQuestionFields.min === 'number' ? currentQuestionFields.min : 1;
  const numberMax = isNumberQuestion && typeof currentQuestionFields.max === 'number' ? currentQuestionFields.max : 10;
  const numberValue = isNumberQuestion ? Number.parseInt(inputValue, 10) : NaN;
  const isNumberValid = isNumberQuestion && Number.isFinite(numberValue) && numberValue >= numberMin && numberValue <= numberMax;
  const hasTags = tags.length > 0;

  // 質問文の変数置換
  const getQuestionText = () => {
    if (!currentQuestion) return '';
    let text = currentQuestion.text;
    Object.keys(answers).forEach(key => {
      text = text.replace(`{${key}}`, answers[key]);
    });
    return text;
  };

  // リアルタイム保存
  // #1045 round-2 (Sonnet Warning): res.ok を確認せずサイレントに失敗していたため、
  // 400 (スキーマ違反等) が起きても気づかず進行してしまっていた。
  // ここでは画面遷移はブロックしない (非同期・非ブロッキングな設計を維持) が、
  // 失敗をユーザーに提示できるよう saveError に反映する。
  const saveProgress = async (step: number, ans: Record<string, any>) => {
    const totalQuestions = calculateTotalQuestions(ans);
    try {
      setIsSaving(true);
      const res = await fetch('/api/onboarding/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentStep: step,
          answers: ans,
          totalQuestions,
        }),
      });
      if (!res.ok) {
        setSaveError(await parseErrorMessage(res));
        return;
      }
      setSaveError(null);
    } catch (error) {
      console.error('Failed to save progress:', error);
      setSaveError(GENERIC_SAVE_ERROR_MESSAGE);
    } finally {
      setIsSaving(false);
    }
  };

  const handleBack = () => {
    if (stepHistory.length === 0) return;
    const prevStep = stepHistory[stepHistory.length - 1];
    setStepHistory(prev => prev.slice(0, -1));
    setCurrentStep(prevStep);
    setInputValue("");
    setSelectedMulti([]);
    setTags([]);
    setTagInput("");
  };

  const handleAnswer = async (value: any) => {
    // #271: multi_choice で空配列のまま回答させない
    if (currentQuestion.type === 'multi_choice' && Array.isArray(value) && value.length === 0) {
      return;
    }

    const mergedAnswers = { ...answers, [currentQuestion.id]: value };
    // #1045 (F6-13): 「戻る」で上流の回答を変更した際、showIf が false になった
    // 下流の回答 (例: nutrition_goal を athlete_performance → lose_weight に変更した
    // 場合の sport_type/training_phase 等) を answers から取り除き、矛盾したプロフィールが
    // 確定しないようにする
    const newAnswers = pruneStaleAnswers(mergedAnswers);
    setAnswers(newAnswers);
    setInputValue("");
    setSelectedMulti([]);
    setTags([]);
    setTagInput("");

    const nextStep = getNextQuestion(currentStep, newAnswers);

    if (nextStep !== -1) {
      setIsTyping(true);
      setStepHistory(prev => [...prev, currentStep]);

      // リアルタイム保存（非同期）
      saveProgress(nextStep, newAnswers);

      setTimeout(() => {
        setCurrentStep(nextStep);
        setIsTyping(false);
      }, 600);
    } else {
      setIsCalculating(true);

      // Fix 1: weight_change_rate を target_weight + target_date から自動算出
      const computedAnswers = { ...newAnswers };

      // Fix 2: exercise_duration を削除しデフォルト値 60 を固定送信
      if (!computedAnswers.exercise_duration) {
        computedAnswers.exercise_duration = '60';
      }
      if (
        (computedAnswers.nutrition_goal === 'lose_weight' || computedAnswers.nutrition_goal === 'gain_muscle') &&
        !computedAnswers.weight_change_rate
      ) {
        if (computedAnswers.target_weight && computedAnswers.target_date) {
          const nowDate = new Date();
          const targetDate = new Date(computedAnswers.target_date);
          const monthsDiff = (targetDate.getTime() - nowDate.getTime()) / (1000 * 60 * 60 * 24 * 30);
          const weightDiff = Math.abs(
            parseFloat(computedAnswers.target_weight) - parseFloat(computedAnswers.weight || '0')
          );
          if (monthsDiff > 0) {
            const kgPerMonth = weightDiff / monthsDiff;
            if (kgPerMonth < 2) {
              computedAnswers.weight_change_rate = 'slow';
            } else if (kgPerMonth < 3) {
              computedAnswers.weight_change_rate = 'moderate';
            } else {
              computedAnswers.weight_change_rate = 'aggressive';
            }
          } else {
            computedAnswers.weight_change_rate = 'moderate';
          }
        } else {
          computedAnswers.weight_change_rate = 'moderate';
        }
      }

      // 完了処理 (fail-closed: progress 保存 → complete の両方が成功したときのみ画面遷移する)
      await runCompletion(computedAnswers);
    }
  };

  // #1045 round-2 (Sonnet Warning): 算出した weight_change_rate を progress に保存してから
  // complete を呼ぶ。以前は両方とも res.ok を確認せず、失敗しても無条件に
  // /onboarding/complete へ遷移していたため、progress が 400 を返すと
  // (a) 回答が保存されないまま (b) complete が「プロフィール不在→デフォルト値で upsert」
  // 分岐に入り、入力した全回答が失われた状態で完了成功の表示だけが出る事故が起きていた。
  // finalizeOnboarding が res.ok を確認し、失敗時は success:false を返すため、
  // その場合は画面遷移せずエラー画面を表示し、ユーザーが再試行できるようにする。
  const runCompletion = async (finalAnswers: Record<string, any>) => {
    setIsCalculating(true);
    setCompletionError(null);
    lastFinalAnswersRef.current = finalAnswers;

    const result = await finalizeOnboarding({
      saveProgress: () =>
        fetch('/api/onboarding/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            currentStep,
            answers: finalAnswers,
            totalQuestions: calculateTotalQuestions(finalAnswers),
          }),
        }),
      completeOnboarding: () => fetch('/api/onboarding/complete', { method: 'POST' }),
    });

    if (!result.success) {
      console.error(`Onboarding finalize failed at stage=${result.stage}: ${result.message}`);
      setIsCalculating(false);
      setCompletionError(result.message);
      return;
    }

    if (result.nextRoute) {
      sessionStorage.setItem('onboarding_next_route', result.nextRoute);
    }

    setTimeout(() => {
      router.push("/onboarding/complete");
    }, 2500);
  };

  const handleMultiSelect = (value: string) => {
    if (value === 'none') {
      setSelectedMulti(['none']);
    } else {
      setSelectedMulti(prev => {
        const filtered = prev.filter(v => v !== 'none');
        if (filtered.includes(value)) {
          return filtered.filter(v => v !== value);
        }
        return [...filtered, value];
      });
    }
  };

  // #1045 round-2 (Sonnet Warning): プレースホルダ「例: 卵、エビ、小麦」がカンマ区切りで
  // 1タグに複数の食材を詰め込む誘因になっており、freeTagList (30文字/件・最大30件) を
  // 超えて Zod ゲートに弾かれる原因になっていた。addTagsFromInput (tag-input.ts) が
  // 「、」「,」「，」区切りで自動的に複数タグへ分割し、件数/文字数上限をスキーマと同じ
  // 定数 (TAG_MAX_LENGTH / TAG_MAX_COUNT) で強制する (単体テスト: onboarding-tag-input.test.ts)。
  const handleAddTag = (rawInput: string) => {
    setTags((prev) => addTagsFromInput(prev, rawInput));
    setTagInput("");
  };

  const handleRemoveTag = (tag: string) => {
    setTags(tags.filter(t => t !== tag));
  };

  const handleSkip = () => {
    handleAnswer(null);
  };

  // 進捗計算
  const calculateProgress = () => {
    let total = 0;
    let current = 0;
    for (let i = 0; i < QUESTIONS.length; i++) {
      const q = QUESTIONS[i];
      if (!q.showIf || q.showIf(answers)) {
        total++;
        if (i <= currentStep) current++;
      }
    }
    return { current, total };
  };

  const progress = calculateProgress();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500 mx-auto mb-4" />
          <p className="text-gray-500">前回の進捗を読み込み中...</p>
        </div>
      </div>
    );
  }

  if (isCalculating) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white flex items-center justify-center">
        <div className="text-center space-y-6">
          <div className="mx-auto w-24 h-24 rounded-full bg-orange-100 flex items-center justify-center">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-orange-500" />
          </div>
          <h2 className="text-2xl font-bold text-gray-900">栄養設計を計算中...</h2>
          <p className="text-sm text-gray-500 leading-relaxed">
            入力いただいた情報をもとに<br />最適な栄養目標を計算しています
          </p>
          <p className="text-xs text-gray-400 mt-4">このまましばらくお待ちください</p>
        </div>
      </div>
    );
  }

  // #1045 round-2 (Sonnet Warning): fail-closed — progress 保存 or complete が失敗した場合、
  // 無言で /onboarding/complete へ遷移させず (= 回答喪失+偽の完了成功を防ぐ)、
  // エラーを提示して再試行できるようにする。
  if (completionError) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white flex items-center justify-center px-4">
        <div className="text-center space-y-4 max-w-sm">
          <div className="mx-auto w-16 h-16 rounded-full bg-red-100 flex items-center justify-center text-2xl">
            ⚠️
          </div>
          <h2 className="text-xl font-bold text-gray-900">保存に失敗しました</h2>
          <p className="text-sm text-gray-500 leading-relaxed">{completionError}</p>
          <Button
            onClick={() => {
              if (lastFinalAnswersRef.current) {
                runCompletion(lastFinalAnswersRef.current);
              }
            }}
            className="w-full py-4 sm:py-5 rounded-xl sm:rounded-2xl bg-gray-900 hover:bg-black text-white font-bold"
          >
            もう一度試す
          </Button>
          {/* #1045 round-3 (Fable Warning): 「もう一度試す」で直らない場合の唯一の
              手段が再試行ループになっていた (デッドエンド)。answers/currentStep は
              state に残っているため、質問画面へ戻して回答を修正できるようにする。 */}
          <Button
            variant="ghost"
            onClick={() => setCompletionError(null)}
            className="w-full py-4 sm:py-5 rounded-xl sm:rounded-2xl text-gray-500 hover:text-gray-700 font-bold"
          >
            回答に戻る
          </Button>
        </div>
      </div>
    );
  }

  if (!currentQuestion) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white flex flex-col items-center justify-between overflow-hidden">

      {/* コンテンツラッパー */}
      <div className="w-full max-w-lg lg:max-w-xl xl:max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col flex-1">

        {/* ヘッダー：進捗 */}
        <div className="w-full pt-6 sm:pt-8 lg:pt-12">
          <div className="flex items-center justify-between text-xs sm:text-sm font-bold text-gray-400 uppercase tracking-widest mb-3 sm:mb-4">
            <div className="flex items-center gap-3">
              {stepHistory.length > 0 && (
                <button
                  onClick={handleBack}
                  className="w-8 h-8 rounded-full border border-gray-200 bg-white flex items-center justify-center hover:bg-gray-50 transition-colors"
                >
                  <svg className="w-4 h-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              )}
              <span>Setup Profile {isSaving && <span className="text-orange-400">(保存中...)</span>}</span>
            </div>
            <div className="flex items-center gap-4">
              <span>{progress.current} / {progress.total}</span>
              <button
                onClick={async () => {
                  if (confirm('後で設定画面から入力できます。スキップしますか？')) {
                    try {
                      await fetch('/api/onboarding/complete', { method: 'POST' });
                      router.push('/menus/weekly');
                    } catch (e) {
                      console.error(e);
                      router.push('/menus/weekly');
                    }
                  }
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors underline underline-offset-2"
              >
                スキップ
              </button>
            </div>
          </div>
          {/* #1045 round-2 (Sonnet Warning): リアルタイム保存の失敗を提示するバナー (非ブロッキング) */}
          {saveError && (
            <p className="normal-case tracking-normal text-[11px] sm:text-xs text-red-500 mb-2">
              {saveError}
            </p>
          )}
          {/* プログレスバー */}
          <div className="w-full h-2 sm:h-2.5 bg-gray-200 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-orange-400 to-orange-500 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${(progress.current / progress.total) * 100}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
        </div>

        {/* メインエリア：チャット */}
        <div className="flex-1 w-full flex flex-col justify-center items-center gap-6 sm:gap-8 lg:gap-10 py-6 sm:py-10 lg:py-12">

          {/* AIアバター */}
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="relative w-16 h-16 sm:w-20 sm:h-20 lg:w-24 lg:h-24"
          >
            <div className="absolute inset-0 bg-orange-400/20 rounded-full animate-pulse" />
            <div className="relative w-16 h-16 sm:w-20 sm:h-20 lg:w-24 lg:h-24 rounded-full bg-gradient-to-br from-orange-400 to-orange-500 flex items-center justify-center text-white text-xl sm:text-2xl lg:text-3xl font-bold shadow-lg border-4 border-white">
              🍳
            </div>
            {isTyping && (
               <div className="absolute -bottom-2 -right-2 bg-white px-2 sm:px-3 py-1 rounded-full text-xs font-bold text-gray-500 shadow-md flex gap-1">
                 <span className="animate-bounce">.</span>
                 <span className="animate-bounce" style={{ animationDelay: '0.1s' }}>.</span>
                 <span className="animate-bounce" style={{ animationDelay: '0.2s' }}>.</span>
               </div>
            )}
          </motion.div>

          {/* 質問バブル */}
          <AnimatePresence mode="wait">
            {!isTyping && (
              <motion.div
                key={currentStep}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="text-center space-y-3 sm:space-y-4 px-2 sm:px-4"
              >
                {getQuestionText().split('\n').map((line, i) => (
                  <p key={i} className="text-base sm:text-lg md:text-xl lg:text-2xl font-bold text-gray-800 leading-relaxed">
                    {line}
                  </p>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* 入力エリア */}
        <div className="w-full pb-6 sm:pb-8 lg:pb-12">
        <AnimatePresence mode="wait">
          {!isTyping && (
            <motion.div
              key={currentStep}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full"
            >
              {/* テキスト入力 */}
              {currentQuestion.type === 'text' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if(inputValue.trim()) handleAnswer(inputValue);
                  }}
                  className="flex gap-2 sm:gap-3"
                >
                  <Input
                    autoFocus
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder={currentQuestion.placeholder}
                    // #1045 round-2 (Sonnet Warning): nickname/sport_custom_name はスキーマ側
                    // shortText.max(NICKNAME_MAX_LENGTH) と揃える。入力欄自体で超過を防ぐ。
                    maxLength={NICKNAME_MAX_LENGTH}
                    className="py-5 sm:py-6 text-base sm:text-lg rounded-xl sm:rounded-2xl border-gray-200 focus:border-orange-400 focus:ring-orange-400/20"
                  />
                  <Button
                    type="submit"
                    disabled={!inputValue.trim()}
                    className="h-12 w-12 sm:h-14 sm:w-14 rounded-xl sm:rounded-2xl bg-gray-900 hover:bg-black text-white shrink-0"
                  >
                    <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" /></svg>
                  </Button>
                </form>
              )}

              {currentQuestion.type === 'number' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (isNumberValid) handleAnswer(numberValue);
                  }}
                  className="flex gap-2 sm:gap-3"
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={numberMin}
                    max={numberMax}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value.replace(/\D/g, ""))}
                    placeholder={currentQuestion.placeholder}
                    className="py-5 sm:py-6 text-base sm:text-lg rounded-xl sm:rounded-2xl border-gray-200 focus:border-orange-400 focus:ring-orange-400/20"
                  />
                  <Button
                    type="submit"
                    disabled={!isNumberValid}
                    className="h-12 w-12 sm:h-14 sm:w-14 rounded-xl sm:rounded-2xl bg-gray-900 hover:bg-black text-white shrink-0"
                  >
                    <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" /></svg>
                  </Button>
                </form>
              )}

              {/* 日付入力 */}
              {currentQuestion.type === 'date' && (
                <div className="space-y-3 sm:space-y-4">
                  <Input
                    type="date"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    min={new Date().toISOString().split('T')[0]}
                    className="py-5 sm:py-6 text-base sm:text-lg rounded-xl sm:rounded-2xl border-gray-200 focus:border-orange-400 focus:ring-orange-400/20 text-center"
                  />
                  <div className="flex gap-2 sm:gap-3">
                    {currentQuestion.allowSkip && (
                      <Button
                        variant="ghost"
                        onClick={handleSkip}
                        className="flex-1 py-4 sm:py-5 rounded-xl sm:rounded-2xl text-gray-400 hover:text-gray-600 text-sm sm:text-base"
                      >
                        スキップ
                      </Button>
                    )}
                    <Button
                      onClick={() => handleAnswer(inputValue)}
                      disabled={!inputValue}
                      className="flex-1 py-4 sm:py-5 rounded-xl sm:rounded-2xl bg-gray-900 hover:bg-black text-white font-bold text-sm sm:text-base"
                    >
                      次へ
                    </Button>
                  </div>
                </div>
              )}

              {/* 単一選択 */}
              {currentQuestion.type === 'choice' && (
                <div className="flex flex-col gap-2 sm:gap-3 max-h-[45vh] sm:max-h-[50vh] overflow-y-auto">
                  {currentQuestion.options?.map((option: any) => (
                    <Button
                      key={option.value}
                      variant="outline"
                      onClick={() => handleAnswer(option.value)}
                      className="w-full py-4 sm:py-5 text-sm sm:text-base rounded-xl sm:rounded-2xl border-gray-200 hover:bg-orange-400 hover:text-white hover:border-orange-400 transition-all duration-300 font-bold text-gray-600 justify-between group px-4 sm:px-6 flex-col items-start h-auto"
                    >
                      <span>{option.label}</span>
                      {option.description && (
                        <span className="text-xs font-normal text-gray-400 group-hover:text-orange-100">{option.description}</span>
                      )}
                    </Button>
                  ))}
                </div>
              )}

              {/* 複数選択 */}
              {currentQuestion.type === 'multi_choice' && (
                <div className="space-y-3 sm:space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-2 sm:gap-3 max-h-[35vh] sm:max-h-[40vh] overflow-y-auto">
                    {currentQuestion.options?.map((option: any) => (
                      <Button
                        key={option.value}
                        variant="outline"
                        onClick={() => handleMultiSelect(option.value)}
                        className={`py-3 sm:py-4 text-xs sm:text-sm rounded-lg sm:rounded-xl border-2 transition-all duration-200 font-bold ${
                          selectedMulti.includes(option.value)
                            ? 'bg-orange-400 text-white border-orange-400'
                            : 'border-gray-200 text-gray-600 hover:border-orange-300'
                        }`}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                  <div className="flex gap-2 sm:gap-3">
                    {currentQuestion.allowSkip && (
                      <Button
                        variant="ghost"
                        onClick={handleSkip}
                        className="flex-1 py-4 sm:py-5 rounded-xl sm:rounded-2xl text-gray-400 hover:text-gray-600 text-sm sm:text-base"
                      >
                        スキップ
                      </Button>
                    )}
                    <Button
                      onClick={() => handleAnswer(selectedMulti)}
                      disabled={selectedMulti.length === 0}
                      className="flex-1 py-4 sm:py-5 rounded-xl sm:rounded-2xl bg-gray-900 hover:bg-black text-white font-bold text-sm sm:text-base"
                    >
                      次へ
                    </Button>
                  </div>
                </div>
              )}

              {/* タグ入力 */}
              {currentQuestion.type === 'tags' && (
                <div className="space-y-3 sm:space-y-4">
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 sm:gap-2">
                      {tags.map((tag) => (
                        <span
                          key={tag}
                          className="px-2.5 sm:px-3 py-1 bg-orange-100 text-orange-600 rounded-full text-xs sm:text-sm font-bold flex items-center gap-1"
                        >
                          {tag}
                          <button onClick={() => handleRemoveTag(tag)} className="hover:text-orange-800">×</button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-1.5 sm:gap-2">
                    {currentQuestion.suggestions?.filter((s: string) => !tags.includes(s)).map((suggestion: string) => (
                      <button
                        key={suggestion}
                        onClick={() => handleAddTag(suggestion)}
                        className="px-2.5 sm:px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-xs sm:text-sm font-bold hover:bg-gray-200 transition-colors"
                      >
                        + {suggestion}
                      </button>
                    ))}
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleAddTag(tagInput);
                    }}
                    className="flex gap-2"
                  >
                    <Input
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      placeholder={currentQuestion.placeholder}
                      // #1045 round-2 (Sonnet Warning): 件数上限に達したら追加不可にする (TAG_MAX_COUNT はスキーマと共通)
                      disabled={tags.length >= TAG_MAX_COUNT}
                      className="py-4 sm:py-5 rounded-lg sm:rounded-xl border-gray-200 text-sm sm:text-base"
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      disabled={tags.length >= TAG_MAX_COUNT}
                      className="px-3 sm:px-4 rounded-lg sm:rounded-xl text-sm sm:text-base"
                    >
                      追加
                    </Button>
                  </form>
                  {tags.length >= TAG_MAX_COUNT && (
                    <p className="text-xs text-red-400">最大{TAG_MAX_COUNT}件まで登録できます</p>
                  )}

                  <div className="flex gap-2 sm:gap-3">
                    <Button
                      variant="ghost"
                      onClick={handleSkip}
                      className="flex-1 py-4 sm:py-5 rounded-xl sm:rounded-2xl text-gray-400 hover:text-gray-600 text-sm sm:text-base"
                    >
                      スキップ
                    </Button>
                    <Button
                      onClick={() => handleAnswer(tags)}
                      disabled={!hasTags}
                      className="flex-1 py-4 sm:py-5 rounded-xl sm:rounded-2xl bg-gray-900 hover:bg-black text-white font-bold text-sm sm:text-base"
                    >
                      次へ
                    </Button>
                  </div>
                </div>
              )}

              {/* カスタム身体情報入力 */}
              {currentQuestion.type === 'custom_stats' && (
                <div className="space-y-3 sm:space-y-4">
                  <div className="grid grid-cols-2 gap-3 sm:gap-4">
                    <div>
                      <label className="text-xs sm:text-sm font-bold text-gray-500 block mb-1">年齢</label>
                      <Input
                        type="number"
                        placeholder="25"
                        // #1045 round-3 (Fable Warning): スキーマ側 numericInRange(AGE_MIN, AGE_MAX)
                        // と同じ範囲を UI 側にも設定し、範囲外値を入力してから 400 で
                        // デッドエンドになる (回答できないが先にも進めない) 事態を防ぐ。
                        min={AGE_MIN}
                        max={AGE_MAX}
                        value={answers.age || ''}
                        className="py-4 sm:py-5 rounded-lg sm:rounded-xl text-center text-base sm:text-lg"
                        onChange={(e) => setAnswers({...answers, age: e.target.value})}
                      />
                    </div>
                    <div>
                      <label className="text-xs sm:text-sm font-bold text-gray-500 block mb-1">職業</label>
                      <Input
                        type="text"
                        placeholder="会社員"
                        value={answers.occupation || ''}
                        // #1045 round-2 (Sonnet Warning): スキーマ側 shortText.max(OCCUPATION_MAX_LENGTH) と揃える
                        maxLength={OCCUPATION_MAX_LENGTH}
                        className="py-4 sm:py-5 rounded-lg sm:rounded-xl text-center text-base sm:text-lg"
                        onChange={(e) => setAnswers({...answers, occupation: e.target.value})}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:gap-4">
                    <div>
                      <label className="text-xs sm:text-sm font-bold text-gray-500 block mb-1">身長 (cm)</label>
                      <Input
                        type="number"
                        placeholder="170"
                        min={50}
                        max={250}
                        step={0.1}
                        value={answers.height || ''}
                        className="py-4 sm:py-5 rounded-lg sm:rounded-xl text-center text-base sm:text-lg"
                        onChange={(e) => setAnswers({...answers, height: e.target.value})}
                      />
                    </div>
                    <div>
                      <label className="text-xs sm:text-sm font-bold text-gray-500 block mb-1">体重 (kg)</label>
                      <Input
                        type="number"
                        placeholder="60"
                        min={10}
                        max={200}
                        step={0.1}
                        value={answers.weight || ''}
                        className="py-4 sm:py-5 rounded-lg sm:rounded-xl text-center text-base sm:text-lg"
                        onChange={(e) => setAnswers({...answers, weight: e.target.value})}
                      />
                    </div>
                  </div>
                  <Button
                    onClick={() => handleAnswer("completed")}
                    disabled={
                      // #1045 round-4 (Fable Suggestion): Number("abc") 等の非数値は NaN になり、
                      // `NaN < AGE_MIN` も `NaN > AGE_MAX` も false になるため、範囲チェックを
                      // すり抜けて disabled が解除されてしまっていた。Number.isFinite で NaN を先に弾く。
                      !answers.age || !Number.isFinite(Number(answers.age)) || Number(answers.age) < AGE_MIN || Number(answers.age) > AGE_MAX ||
                      !answers.height || !Number.isFinite(Number(answers.height)) || Number(answers.height) < 50 || Number(answers.height) > 250 ||
                      !answers.weight || !Number.isFinite(Number(answers.weight)) || Number(answers.weight) < 10 || Number(answers.weight) > 200
                    }
                    className="w-full py-4 sm:py-5 rounded-xl sm:rounded-2xl bg-gray-900 hover:bg-black text-white font-bold mt-3 sm:mt-4 text-sm sm:text-base"
                  >
                    次へ
                  </Button>
                </div>
              )}

              {/* 曜日別人数設定グリッド */}
              {currentQuestion.type === 'servings_grid' && (
                <div className="space-y-4">
                  {/* Fix 3: 基本人数入力（family_size 質問を削除してここに統合） */}
                  <div className="flex items-center gap-3 justify-center">
                    <label className="text-sm font-bold text-gray-600">基本人数：</label>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          const current = parseInt(answers.family_size) || 2;
                          const next = Math.max(1, current - 1);
                          const newConfig = createDefaultServingsConfig(next);
                          setAnswers({ ...answers, family_size: String(next), servings_config: newConfig });
                        }}
                        className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center font-bold text-gray-600 hover:bg-gray-100"
                      >
                        −
                      </button>
                      <span className="text-lg font-bold text-gray-800 min-w-[2ch] text-center">
                        {parseInt(answers.family_size) || 2}
                      </span>
                      <button
                        onClick={() => {
                          const current = parseInt(answers.family_size) || 2;
                          const next = Math.min(10, current + 1);
                          const newConfig = createDefaultServingsConfig(next);
                          setAnswers({ ...answers, family_size: String(next), servings_config: newConfig });
                        }}
                        className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center font-bold text-gray-600 hover:bg-gray-100"
                      >
                        +
                      </button>
                      <span className="text-sm text-gray-500">人</span>
                    </div>
                  </div>
                  <p className="text-center text-sm text-gray-500">
                    各セルをクリックして人数を変更できます
                  </p>

                  {/* ヘッダー行 */}
                  <div className="grid grid-cols-4 gap-2">
                    <div /> {/* 空セル */}
                    {MEAL_TYPES.map((meal) => (
                      <div key={meal.key} className="text-center font-bold text-gray-700">
                        {meal.label}
                      </div>
                    ))}
                  </div>

                  {/* 曜日行 */}
                  {DAYS_OF_WEEK.map((day) => {
                    const familySize = parseInt(answers.family_size) || 2;
                    const currentConfig: ServingsConfig = answers.servings_config || createDefaultServingsConfig(familySize);
                    
                    return (
                      <div key={day.key} className="grid grid-cols-4 gap-2">
                        <div className={`flex items-center justify-center font-bold ${
                          day.key === 'saturday' || day.key === 'sunday' ? 'text-red-500' : 'text-gray-700'
                        }`}>
                          {day.label}
                        </div>
                        {MEAL_TYPES.map((meal) => {
                          const value = currentConfig.byDayMeal?.[day.key]?.[meal.key] ?? familySize;
                          
                          const updateValue = (newValue: number) => {
                            const clampedValue = Math.max(0, Math.min(10, newValue));
                            const updatedConfig = { ...currentConfig };
                            if (!updatedConfig.byDayMeal) updatedConfig.byDayMeal = {};
                            if (!updatedConfig.byDayMeal[day.key]) updatedConfig.byDayMeal[day.key] = {};
                            updatedConfig.byDayMeal[day.key][meal.key] = clampedValue;
                            setAnswers({ ...answers, servings_config: updatedConfig });
                          };
                          
                          return (
                            <div
                              key={meal.key}
                              className={`flex items-center justify-between rounded-lg px-1 ${
                                value === 0
                                  ? 'bg-gray-100 border border-gray-200'
                                  : 'bg-green-50 border border-green-300'
                              }`}
                            >
                              <button
                                onClick={() => updateValue(value - 1)}
                                className={`w-7 h-10 flex items-center justify-center text-lg font-bold ${
                                  value === 0 ? 'text-gray-400' : 'text-green-700'
                                }`}
                              >
                                −
                              </button>
                              <span className={`font-bold text-center min-w-[16px] ${
                                value === 0 ? 'text-gray-400' : 'text-green-700'
                              }`}>
                                {value === 0 ? '-' : value}
                              </span>
                              <button
                                onClick={() => updateValue(value + 1)}
                                className={`w-7 h-10 flex items-center justify-center text-lg font-bold ${
                                  value === 0 ? 'text-gray-400' : 'text-green-700'
                                }`}
                              >
                                +
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                  
                  {/* 凡例 */}
                  <div className="flex justify-center gap-6 mt-4">
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 bg-green-50 border border-green-300 rounded" />
                      <span className="text-xs text-gray-600">作る</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 bg-gray-100 border border-gray-200 rounded" />
                      <span className="text-xs text-gray-600">作らない</span>
                    </div>
                  </div>
                  
                  <Button
                    onClick={() => {
                      const familySize = parseInt(answers.family_size) || 2;
                      const config: ServingsConfig = answers.servings_config || createDefaultServingsConfig(familySize);
                      // Fix 3: family_size = servings_config.default を保証
                      const finalConfig: ServingsConfig = { ...config, default: familySize };
                      // family_size も同期して保存（progress API が読む）
                      setAnswers({ ...answers, family_size: String(familySize), servings_config: finalConfig });
                      handleAnswer(finalConfig);
                    }}
                    className="w-full py-4 sm:py-5 rounded-xl sm:rounded-2xl bg-gray-900 hover:bg-black text-white font-bold mt-4 text-sm sm:text-base"
                  >
                    次へ
                  </Button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// Suspense境界でラップしたエクスポート
export default function OnboardingQuestionsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500 mx-auto mb-4" />
          <p className="text-gray-500">読み込み中...</p>
        </div>
      </div>
    }>
      <OnboardingQuestionsContent />
    </Suspense>
  );
}
