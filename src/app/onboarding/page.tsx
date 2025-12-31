"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { motion, AnimatePresence } from "framer-motion";

// 質問データの定義（運動・目標・健康情報を詳細に収集）
const QUESTIONS = [
  {
    id: 'nickname',
    text: 'はじめまして！🍳\n私はあなたの食生活をサポートするAI栄養士です。\n\nお名前（ニックネーム）を教えてください',
    type: 'text',
    placeholder: '例: たろう',
    required: true,
  },
  {
    id: 'gender',
    text: '{nickname}さん、よろしくお願いします！\n\n正確な栄養計算のために、性別を教えてください',
    type: 'choice',
    options: [
      { label: '👨 男性', value: 'male' },
      { label: '👩 女性', value: 'female' },
      { label: '🙂 回答しない', value: 'unspecified' },
    ]
  },
  {
    id: 'body_stats',
    text: '基礎代謝を計算するために、\n身体情報を教えてください',
    type: 'custom_stats',
  },
  {
    id: 'nutrition_goal',
    text: '一番の目標は何ですか？',
    type: 'choice',
    options: [
      { label: '🏃 減量・ダイエット', value: 'lose_weight', description: '体重を落としたい' },
      { label: '💪 筋肉増量・バルクアップ', value: 'gain_muscle', description: '筋肉をつけたい' },
      { label: '⚖️ 現状維持・健康管理', value: 'maintain', description: '今の体型を維持したい' },
      { label: '🏆 競技パフォーマンス', value: 'athlete_performance', description: '大会・試合に向けて' },
    ]
  },
  {
    id: 'weight_change_rate',
    text: 'どのくらいのペースで変えたいですか？',
    type: 'choice',
    showIf: (answers: Record<string, any>) => 
      answers.nutrition_goal === 'lose_weight' || answers.nutrition_goal === 'gain_muscle',
    options: [
      { label: '🐢 ゆっくり（月1-2kg）', value: 'slow', description: '無理なく長期的に' },
      { label: '🚶 普通（月2-3kg）', value: 'moderate', description: 'バランス重視' },
      { label: '🚀 積極的（月3kg以上）', value: 'aggressive', description: '短期集中で' },
    ]
  },
  {
    id: 'exercise_types',
    text: '普段どんな運動をしていますか？\n（複数選択可）',
    type: 'multi_choice',
    options: [
      { label: '🏋️ 筋トレ・ウェイト', value: 'weight_training' },
      { label: '🏃 ランニング・ジョギング', value: 'running' },
      { label: '🚴 サイクリング', value: 'cycling' },
      { label: '🏊 水泳', value: 'swimming' },
      { label: '🧘 ヨガ・ピラティス', value: 'yoga' },
      { label: '⚽ 球技・チームスポーツ', value: 'team_sports' },
      { label: '🥊 格闘技・ボクシング', value: 'martial_arts' },
      { label: '🚶 ウォーキング', value: 'walking' },
      { label: '❌ 運動していない', value: 'none' },
    ],
  },
  {
    id: 'exercise_frequency',
    text: '週に何日運動していますか？',
    type: 'choice',
    showIf: (answers: Record<string, any>) => 
      !answers.exercise_types?.includes('none'),
    options: [
      { label: '1日', value: '1' },
      { label: '2日', value: '2' },
      { label: '3日', value: '3' },
      { label: '4日', value: '4' },
      { label: '5日', value: '5' },
      { label: '6日以上', value: '6' },
    ]
  },
  {
    id: 'exercise_intensity',
    text: '運動の強度はどのくらいですか？',
    type: 'choice',
    showIf: (answers: Record<string, any>) => 
      !answers.exercise_types?.includes('none'),
    options: [
      { label: '🚶 軽い（息が上がらない程度）', value: 'light', description: 'ウォーキング、軽いヨガなど' },
      { label: '🏃 普通（少し息が上がる）', value: 'moderate', description: 'ジョギング、一般的な筋トレなど' },
      { label: '🔥 激しい（かなり息が上がる）', value: 'intense', description: 'HIIT、高重量トレーニングなど' },
      { label: '💪 アスリートレベル', value: 'athlete', description: '毎日ハードなトレーニング' },
    ]
  },
  {
    id: 'exercise_duration',
    text: '1回の運動時間は？',
    type: 'choice',
    showIf: (answers: Record<string, any>) => 
      !answers.exercise_types?.includes('none'),
    options: [
      { label: '⏱️ 30分未満', value: '30' },
      { label: '⏱️ 30分〜1時間', value: '60' },
      { label: '⏱️ 1〜2時間', value: '90' },
      { label: '⏱️ 2時間以上', value: '120' },
    ]
  },
  {
    id: 'work_style',
    text: '普段の仕事・活動スタイルは？',
    type: 'choice',
    options: [
      { label: '💻 デスクワーク（座り仕事）', value: 'sedentary' },
      { label: '🏢 オフィス（立ち座り半々）', value: 'light_active' },
      { label: '🚶 立ち仕事・移動多め', value: 'moderately_active' },
      { label: '🔨 肉体労働', value: 'very_active' },
      { label: '📚 学生', value: 'student' },
      { label: '🏠 主婦/主夫', value: 'homemaker' },
    ]
  },
  {
    id: 'health_conditions',
    text: '気になる健康状態はありますか？\n（複数選択可、なければスキップ）',
    type: 'multi_choice',
    options: [
      { label: '📈 高血圧', value: '高血圧' },
      { label: '🍬 糖尿病・血糖値', value: '糖尿病' },
      { label: '🩸 脂質異常症', value: '脂質異常症' },
      { label: '🫀 心臓病', value: '心臓病' },
      { label: '🫁 腎臓病', value: '腎臓病' },
      { label: '🦴 骨粗しょう症', value: '骨粗しょう症' },
      { label: '🩺 貧血', value: '貧血' },
      { label: '🦶 痛風', value: '痛風' },
      { label: '✅ 特になし', value: 'none' },
    ],
    allowSkip: true,
  },
  {
    id: 'medications',
    text: '服用中の薬はありますか？\n（食事に影響するものを選択）',
    type: 'multi_choice',
    options: [
      { label: '💊 ワーファリン（血液サラサラ）', value: 'warfarin' },
      { label: '💊 降圧剤', value: 'antihypertensive' },
      { label: '💊 糖尿病薬', value: 'diabetes_medication' },
      { label: '💊 利尿剤', value: 'diuretic' },
      { label: '💊 抗生物質', value: 'antibiotics' },
      { label: '💊 ステロイド', value: 'steroid' },
      { label: '✅ 特になし', value: 'none' },
    ],
    allowSkip: true,
  },
  {
    id: 'allergies',
    text: '食物アレルギーや苦手な食材は？\n（なければスキップ）',
    type: 'tags',
    placeholder: '例: 卵、エビ、ピーマン',
    suggestions: ['卵', 'エビ', 'カニ', '小麦', '乳製品', 'そば', '落花生', 'ナッツ類', '貝類', '魚卵', '大豆'],
    allowSkip: true,
  },
  {
    id: 'cooking_experience',
    text: '料理の経験は？',
    type: 'choice',
    options: [
      { label: '🔰 初心者（1年未満）', value: 'beginner' },
      { label: '👨‍🍳 中級者（1-3年）', value: 'intermediate' },
      { label: '👨‍🍳 上級者（3年以上）', value: 'advanced' },
    ]
  },
  {
    id: 'cooking_time',
    text: '平日の夕食にかけられる調理時間は？',
    type: 'choice',
    options: [
      { label: '⚡ 15分以内', value: '15' },
      { label: '🕐 30分以内', value: '30' },
      { label: '🕑 45分以内', value: '45' },
      { label: '🕒 1時間以上OK', value: '60' },
    ]
  },
  {
    id: 'cuisine_preference',
    text: '好きな料理ジャンルは？\n（複数選択可）',
    type: 'multi_choice',
    options: [
      { label: '🍱 和食', value: 'japanese' },
      { label: '🍝 洋食', value: 'western' },
      { label: '🥡 中華', value: 'chinese' },
      { label: '🍕 イタリアン', value: 'italian' },
      { label: '🌶️ エスニック', value: 'ethnic' },
      { label: '🥘 韓国料理', value: 'korean' },
    ]
  },
  {
    id: 'family_size',
    text: '何人分の食事を作りますか？',
    type: 'choice',
    options: [
      { label: '👤 1人', value: '1' },
      { label: '👥 2人', value: '2' },
      { label: '👨‍👩‍👧 3人', value: '3' },
      { label: '👨‍👩‍👧‍👦 4人以上', value: '4' },
    ]
  },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [inputValue, setInputValue] = useState("");
  const [selectedMulti, setSelectedMulti] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [isTyping, setIsTyping] = useState(false);

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

  const currentQuestion = QUESTIONS[currentStep];

  // 質問文の変数置換
  const getQuestionText = () => {
    let text = currentQuestion.text;
    Object.keys(answers).forEach(key => {
      text = text.replace(`{${key}}`, answers[key]);
    });
    return text;
  };

  const handleAnswer = async (value: any) => {
    const newAnswers = { ...answers, [currentQuestion.id]: value };
    setAnswers(newAnswers);
    setInputValue("");
    setSelectedMulti([]);
    setTags([]);
    setTagInput("");

    const nextStep = getNextQuestion(currentStep, newAnswers);

    if (nextStep !== -1) {
      setIsTyping(true);
      setTimeout(() => {
        setCurrentStep(nextStep);
        setIsTyping(false);
      }, 600);
    } else {
      setIsTyping(true);
      
      // APIへ送信（拡張データ含む）
      try {
        const profileData = transformAnswersToProfile(newAnswers);
        const res = await fetch('/api/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profileData),
        });
        
        if (res.ok) {
          // 栄養目標を自動計算
          await fetch('/api/nutrition-targets/calculate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
        }
      } catch (e) {
        console.error(e);
      }

      setTimeout(() => {
        router.push("/onboarding/complete");
      }, 1500);
    }
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

  const handleAddTag = (tag: string) => {
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag]);
    }
    setTagInput("");
  };

  const handleRemoveTag = (tag: string) => {
    setTags(tags.filter(t => t !== tag));
  };

  const handleSkip = () => {
    handleAnswer(null);
  };

  // 回答をプロファイル形式に変換
  const transformAnswersToProfile = (ans: Record<string, any>) => {
    const profile: Record<string, any> = {
      nickname: ans.nickname,
      gender: ans.gender,
      age: ans.age ? parseInt(ans.age) : null,
      occupation: ans.occupation,
      height: ans.height ? parseFloat(ans.height) : null,
      weight: ans.weight ? parseFloat(ans.weight) : null,
    };

    // 栄養目標
    if (ans.nutrition_goal) {
      profile.nutritionGoal = ans.nutrition_goal;
    }

    // 体重変化ペース
    if (ans.weight_change_rate) {
      profile.weightChangeRate = ans.weight_change_rate;
    }

    // 運動の種類
    if (ans.exercise_types?.length && !ans.exercise_types.includes('none')) {
      profile.exerciseTypes = ans.exercise_types;
    }

    // 運動頻度
    if (ans.exercise_frequency) {
      profile.exerciseFrequency = parseInt(ans.exercise_frequency);
    }

    // 運動強度
    if (ans.exercise_intensity) {
      profile.exerciseIntensity = ans.exercise_intensity;
    }

    // 運動時間
    if (ans.exercise_duration) {
      profile.exerciseDurationPerSession = parseInt(ans.exercise_duration);
    }

    // 仕事スタイル
    if (ans.work_style) {
      profile.workStyle = ans.work_style;
    }

    // 健康状態
    if (ans.health_conditions?.length && !ans.health_conditions.includes('none')) {
      profile.healthConditions = ans.health_conditions;
    }

    // 服用中の薬
    if (ans.medications?.length && !ans.medications.includes('none')) {
      profile.medications = ans.medications;
    }

    // アレルギー
    if (ans.allergies?.length) {
      profile.dietFlags = {
        allergies: ans.allergies,
        dislikes: [],
      };
    }

    // 料理経験
    if (ans.cooking_experience) {
      profile.cookingExperience = ans.cooking_experience;
    }

    // 調理時間
    if (ans.cooking_time) {
      profile.weekdayCookingMinutes = parseInt(ans.cooking_time);
    }

    // 料理ジャンル嗜好
    if (ans.cuisine_preference?.length) {
      const prefs: Record<string, number> = {};
      ans.cuisine_preference.forEach((c: string) => {
        prefs[c] = 5;
      });
      profile.cuisinePreferences = prefs;
    }

    // 家族人数
    if (ans.family_size) {
      profile.familySize = parseInt(ans.family_size);
    }

    return profile;
  };

  // 進捗計算（条件付き質問を考慮）
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

  return (
    <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white flex flex-col items-center justify-between overflow-hidden">

      {/* コンテンツラッパー - 画面サイズに応じて幅を調整 */}
      <div className="w-full max-w-lg lg:max-w-xl xl:max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col flex-1">

        {/* ヘッダー：進捗 */}
        <div className="w-full pt-6 sm:pt-8 lg:pt-12">
          <div className="flex items-center justify-between text-xs sm:text-sm font-bold text-gray-400 uppercase tracking-widest mb-3 sm:mb-4">
            <span>Setup Profile</span>
            <span>{progress.current} / {progress.total}</span>
          </div>
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
                  {/* 選択済みタグ */}
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

                  {/* サジェスト */}
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

                  {/* 入力フィールド */}
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
                      className="py-4 sm:py-5 rounded-lg sm:rounded-xl border-gray-200 text-sm sm:text-base"
                    />
                    <Button type="submit" variant="outline" className="px-3 sm:px-4 rounded-lg sm:rounded-xl text-sm sm:text-base">
                      追加
                    </Button>
                  </form>

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
                        className="py-4 sm:py-5 rounded-lg sm:rounded-xl text-center text-base sm:text-lg"
                        onChange={(e) => setAnswers({...answers, age: e.target.value})}
                      />
                    </div>
                    <div>
                      <label className="text-xs sm:text-sm font-bold text-gray-500 block mb-1">職業</label>
                      <Input
                        type="text"
                        placeholder="会社員"
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
                        className="py-4 sm:py-5 rounded-lg sm:rounded-xl text-center text-base sm:text-lg"
                        onChange={(e) => setAnswers({...answers, height: e.target.value})}
                      />
                    </div>
                    <div>
                      <label className="text-xs sm:text-sm font-bold text-gray-500 block mb-1">体重 (kg)</label>
                      <Input
                        type="number"
                        placeholder="60"
                        className="py-4 sm:py-5 rounded-lg sm:rounded-xl text-center text-base sm:text-lg"
                        onChange={(e) => setAnswers({...answers, weight: e.target.value})}
                      />
                    </div>
                  </div>
                  <Button
                    onClick={() => handleAnswer("completed")}
                    disabled={!answers.age || !answers.height || !answers.weight}
                    className="w-full py-4 sm:py-5 rounded-xl sm:rounded-2xl bg-gray-900 hover:bg-black text-white font-bold mt-3 sm:mt-4 text-sm sm:text-base"
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
