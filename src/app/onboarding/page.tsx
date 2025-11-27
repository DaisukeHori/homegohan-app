"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { motion, AnimatePresence } from "framer-motion";

// 質問データの定義（拡充版）
const QUESTIONS = [
  {
    id: 'nickname',
    text: 'はじめまして。私はあなたの食生活をサポートするAIパートナーです。\nまずは、あなたのことを教えてください。\n\nお名前（ニックネーム）は何とお呼びしましょうか？',
    type: 'text',
    placeholder: '例: たろう',
    required: true,
  },
  {
    id: 'gender',
    text: '{nickname}さん、こんにちは！\nより正確な栄養分析のために、性別を教えていただけますか？',
    type: 'choice',
    options: [
      { label: '男性', value: 'male' },
      { label: '女性', value: 'female' },
      { label: '回答しない', value: 'unspecified' },
    ]
  },
  {
    id: 'body_stats',
    text: 'よりパーソナライズするために、\n年齢・職業・身長・体重を教えていただけますか？\n（正確な基礎代謝の計算に使用します）',
    type: 'custom_stats',
  },
  {
    id: 'fitness_goals',
    text: '食事で達成したい目標を教えてください。\n（複数選択可）',
    type: 'multi_choice',
    options: [
      { label: '🏃 減量・ダイエット', value: 'lose_weight' },
      { label: '💪 筋肉をつけたい', value: 'build_muscle' },
      { label: '⚡ エネルギー・集中力UP', value: 'improve_energy' },
      { label: '✨ 美肌・美容', value: 'improve_skin' },
      { label: '🌿 腸活・便秘改善', value: 'gut_health' },
      { label: '🛡️ 免疫力向上', value: 'immunity' },
      { label: '🧠 集中力・脳活性', value: 'focus' },
      { label: '❤️ 健康維持', value: 'health' },
    ]
  },
  {
    id: 'work_style',
    text: '普段の仕事スタイルに近いものはどれですか？',
    type: 'choice',
    options: [
      { label: '💻 デスクワーク中心', value: 'remote' },
      { label: '🏢 オフィス勤務', value: 'fulltime' },
      { label: '🚶 立ち仕事・移動多め', value: 'parttime' },
      { label: '🔨 肉体労働', value: 'shift' },
      { label: '📚 学生', value: 'student' },
      { label: '🏠 主婦/主夫', value: 'homemaker' },
    ]
  },
  {
    id: 'exercise',
    text: '週にどのくらい運動していますか？',
    type: 'choice',
    options: [
      { label: '🚶 ほとんどしない（0-30分）', value: '0' },
      { label: '🏃 軽い運動（30-60分）', value: '45' },
      { label: '💪 定期的に運動（1-3時間）', value: '120' },
      { label: '🏋️ しっかり運動（3時間以上）', value: '240' },
    ]
  },
  {
    id: 'health_conditions',
    text: '気になる健康状態はありますか？\n（複数選択可、なければスキップ）',
    type: 'multi_choice',
    options: [
      { label: '📈 高血圧', value: '高血圧' },
      { label: '🍬 糖尿病・血糖値が気になる', value: '糖尿病' },
      { label: '🩸 脂質異常症・コレステロール', value: '脂質異常症' },
      { label: '😴 睡眠の質が悪い', value: '睡眠障害' },
      { label: '😫 ストレスが多い', value: 'ストレス' },
      { label: '🩺 貧血気味', value: '貧血' },
      { label: '🦴 骨粗しょう症', value: '骨粗しょう症' },
      { label: '✅ 特になし', value: 'none' },
    ],
    allowSkip: true,
  },
  {
    id: 'allergies',
    text: '食物アレルギーや苦手な食材はありますか？\n（なければスキップ）',
    type: 'tags',
    placeholder: '例: 卵、エビ、ピーマン',
    suggestions: ['卵', 'エビ', 'カニ', '小麦', '乳製品', 'そば', '落花生', 'ナッツ類', '貝類', '魚卵'],
    allowSkip: true,
  },
  {
    id: 'cooking_experience',
    text: '料理の経験はどのくらいですか？',
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

    if (currentStep < QUESTIONS.length - 1) {
      setIsTyping(true);
      setTimeout(() => {
        setCurrentStep(prev => prev + 1);
        setIsTyping(false);
      }, 600);
    } else {
      setIsTyping(true);
      
      // APIへ送信（拡張データ含む）
      try {
        const profileData = transformAnswersToProfile(newAnswers);
        await fetch('/api/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profileData),
        });
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
      age: ans.age,
      occupation: ans.occupation,
      height: ans.height,
      weight: ans.weight,
    };

    // 目標
    if (ans.fitness_goals?.length) {
      profile.fitnessGoals = ans.fitness_goals.filter((g: string) => g !== 'none');
    }

    // 仕事スタイル
    if (ans.work_style) {
      profile.workStyle = ans.work_style;
    }

    // 運動時間
    if (ans.exercise) {
      profile.weeklyExerciseMinutes = parseInt(ans.exercise) * 7;
    }

    // 健康状態
    if (ans.health_conditions?.length) {
      profile.healthConditions = ans.health_conditions.filter((h: string) => h !== 'none');
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

  return (
    <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white flex flex-col items-center justify-between p-6 max-w-lg mx-auto overflow-hidden">
      
      {/* ヘッダー：進捗 */}
      <div className="w-full pt-8">
        <div className="flex items-center justify-between text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">
          <span>Setup Profile</span>
          <span>{currentStep + 1} / {QUESTIONS.length}</span>
        </div>
        {/* プログレスバー */}
        <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
          <motion.div 
            className="h-full bg-gradient-to-r from-orange-400 to-orange-500 rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${((currentStep + 1) / QUESTIONS.length) * 100}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
      </div>

      {/* メインエリア：チャット */}
      <div className="flex-1 w-full flex flex-col justify-center items-center gap-8 py-10">
        
        {/* AIアバター */}
        <motion.div 
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          className="relative w-20 h-20"
        >
          <div className="absolute inset-0 bg-orange-400/20 rounded-full animate-pulse" />
          <div className="relative w-20 h-20 rounded-full bg-gradient-to-br from-orange-400 to-orange-500 flex items-center justify-center text-white text-2xl font-bold shadow-lg border-4 border-white">
            🍳
          </div>
          {isTyping && (
             <div className="absolute -bottom-2 -right-2 bg-white px-3 py-1 rounded-full text-xs font-bold text-gray-500 shadow-md flex gap-1">
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
              className="text-center space-y-4 px-4"
            >
              {getQuestionText().split('\n').map((line, i) => (
                <p key={i} className="text-lg md:text-xl font-bold text-gray-800 leading-relaxed">
                  {line}
                </p>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 入力エリア */}
      <div className="w-full pb-8">
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
                  className="flex gap-2"
                >
                  <Input 
                    autoFocus
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder={currentQuestion.placeholder}
                    className="py-6 text-lg rounded-2xl border-gray-200 focus:border-orange-400 focus:ring-orange-400/20"
                  />
                  <Button 
                    type="submit" 
                    disabled={!inputValue.trim()}
                    className="h-14 w-14 rounded-2xl bg-gray-900 hover:bg-black text-white shrink-0"
                  >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" /></svg>
                  </Button>
                </form>
              )}

              {/* 単一選択 */}
              {currentQuestion.type === 'choice' && (
                <div className="flex flex-col gap-3">
                  {currentQuestion.options?.map((option) => (
                    <Button
                      key={option.value}
                      variant="outline"
                      onClick={() => handleAnswer(option.value)}
                      className="w-full py-5 text-base rounded-2xl border-gray-200 hover:bg-orange-400 hover:text-white hover:border-orange-400 transition-all duration-300 font-bold text-gray-600 justify-between group px-6"
                    >
                      {option.label}
                      <svg className="w-5 h-5 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4" /></svg>
                    </Button>
                  ))}
                </div>
              )}

              {/* 複数選択 */}
              {currentQuestion.type === 'multi_choice' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-2">
                    {currentQuestion.options?.map((option) => (
                      <Button
                        key={option.value}
                        variant="outline"
                        onClick={() => handleMultiSelect(option.value)}
                        className={`py-4 text-sm rounded-xl border-2 transition-all duration-200 font-bold ${
                          selectedMulti.includes(option.value)
                            ? 'bg-orange-400 text-white border-orange-400'
                            : 'border-gray-200 text-gray-600 hover:border-orange-300'
                        }`}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    {currentQuestion.allowSkip && (
                      <Button
                        variant="ghost"
                        onClick={handleSkip}
                        className="flex-1 py-5 rounded-2xl text-gray-400 hover:text-gray-600"
                      >
                        スキップ
                      </Button>
                    )}
                    <Button
                      onClick={() => handleAnswer(selectedMulti)}
                      disabled={selectedMulti.length === 0}
                      className="flex-1 py-5 rounded-2xl bg-gray-900 hover:bg-black text-white font-bold"
                    >
                      次へ
                    </Button>
                  </div>
                </div>
              )}

              {/* タグ入力 */}
              {currentQuestion.type === 'tags' && (
                <div className="space-y-4">
                  {/* 選択済みタグ */}
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {tags.map((tag) => (
                        <span
                          key={tag}
                          className="px-3 py-1 bg-orange-100 text-orange-600 rounded-full text-sm font-bold flex items-center gap-1"
                        >
                          {tag}
                          <button onClick={() => handleRemoveTag(tag)} className="hover:text-orange-800">×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  
                  {/* サジェスト */}
                  <div className="flex flex-wrap gap-2">
                    {currentQuestion.suggestions?.filter(s => !tags.includes(s)).map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => handleAddTag(suggestion)}
                        className="px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-sm font-bold hover:bg-gray-200 transition-colors"
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
                      className="py-5 rounded-xl border-gray-200"
                    />
                    <Button type="submit" variant="outline" className="px-4 rounded-xl">
                      追加
                    </Button>
                  </form>
                  
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      onClick={handleSkip}
                      className="flex-1 py-5 rounded-2xl text-gray-400 hover:text-gray-600"
                    >
                      スキップ
                    </Button>
                    <Button
                      onClick={() => handleAnswer(tags)}
                      className="flex-1 py-5 rounded-2xl bg-gray-900 hover:bg-black text-white font-bold"
                    >
                      次へ
                    </Button>
                  </div>
                </div>
              )}
              
              {/* カスタム身体情報入力 */}
              {currentQuestion.type === 'custom_stats' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-bold text-gray-500 block mb-1">年齢</label>
                      <Input 
                        type="number" 
                        placeholder="25" 
                        className="py-5 rounded-xl text-center text-lg"
                        onChange={(e) => setAnswers({...answers, age: e.target.value})}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-bold text-gray-500 block mb-1">職業</label>
                      <Input 
                        type="text" 
                        placeholder="会社員" 
                        className="py-5 rounded-xl text-center text-lg"
                        onChange={(e) => setAnswers({...answers, occupation: e.target.value})}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-bold text-gray-500 block mb-1">身長 (cm)</label>
                      <Input 
                        type="number" 
                        placeholder="170" 
                        className="py-5 rounded-xl text-center text-lg"
                        onChange={(e) => setAnswers({...answers, height: e.target.value})}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-bold text-gray-500 block mb-1">体重 (kg)</label>
                      <Input 
                        type="number" 
                        placeholder="60" 
                        className="py-5 rounded-xl text-center text-lg"
                        onChange={(e) => setAnswers({...answers, weight: e.target.value})}
                      />
                    </div>
                  </div>
                  <Button 
                    onClick={() => handleAnswer("completed")}
                    disabled={!answers.age || !answers.height || !answers.weight}
                    className="w-full py-5 rounded-2xl bg-gray-900 hover:bg-black text-white font-bold mt-4"
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
  );
}
