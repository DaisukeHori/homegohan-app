"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { motion, AnimatePresence } from "framer-motion";

// 質問データの定義
const QUESTIONS = [
  {
    id: 'nickname',
    text: 'はじめまして。私はあなたの食生活をサポートするAIパートナーです。\nまずは、あなたのことを教えてください。\n\nお名前（ニックネーム）は何とお呼びしましょうか？',
    type: 'text',
    placeholder: '例: たろう',
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
    id: 'lifestyle',
    text: 'ありがとうございます。\n普段の生活スタイルに近いものはどれですか？',
    type: 'choice',
    options: [
      { label: '座り仕事が中心', value: 'desk_work' },
      { label: '立ち仕事・移動が多い', value: 'active_work' },
      { label: 'ハードな肉体労働', value: 'hard_work' },
      { label: '学生・学習中心', value: 'student' },
    ]
  },
  {
    id: 'body_stats',
    text: 'よりパーソナライズするために、\n年齢・職業・身長・体重を教えていただけますか？\n（正確な基礎代謝の計算に使用します）',
    type: 'custom_stats', // 新しいタイプ
  },
  {
    id: 'goal',
    text: '最後に、一番大切にしたいことを教えてください。\nこれに合わせて、サポートの方針を決めますね。',
    type: 'choice',
    options: [
      { label: 'エネルギー・集中力の維持', value: 'performance' },
      { label: '健康的な体型の維持・改善', value: 'body_make' },
      { label: '肌や体調のコンディション', value: 'condition' },
      { label: 'とにかく健康でいたい', value: 'health' },
    ]
  }
];

export default function OnboardingPage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [inputValue, setInputValue] = useState("");
  const [isTyping, setIsTyping] = useState(false); // AIが入力中かどうか

  const currentQuestion = QUESTIONS[currentStep];

  // 質問文の変数置換（{nickname}などを実際の値に）
  const getQuestionText = () => {
    let text = currentQuestion.text;
    Object.keys(answers).forEach(key => {
      text = text.replace(`{${key}}`, answers[key]);
    });
    return text;
  };

  const handleAnswer = async (value: string) => {
    // 回答を保存
    const newAnswers = { ...answers, [currentQuestion.id]: value };
    setAnswers(newAnswers);
    setInputValue("");

    if (currentStep < QUESTIONS.length - 1) {
      // 次の質問へ（少し間を持たせてAIが考えている感を出す）
      setIsTyping(true);
      setTimeout(() => {
        setCurrentStep(prev => prev + 1);
        setIsTyping(false);
      }, 800);
    } else {
      // 全ステップ完了
      setIsTyping(true);
      
      // APIへ送信
      try {
        await fetch('/api/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(answers),
        });
      } catch (e) {
        console.error(e);
      }

      setTimeout(() => {
        router.push("/onboarding/complete");
      }, 1500);
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-between p-6 max-w-lg mx-auto overflow-hidden">
      
      {/* ヘッダー：進捗 */}
      <div className="w-full pt-8 flex items-center justify-between text-xs font-bold text-gray-400 uppercase tracking-widest">
        <span>Setup Profile</span>
        <span>{currentStep + 1} / {QUESTIONS.length}</span>
      </div>

      {/* メインエリア：チャット */}
      <div className="flex-1 w-full flex flex-col justify-center items-center gap-8 py-10">
        
        {/* AIアバター */}
        <motion.div 
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          className="relative w-24 h-24"
        >
          <div className="absolute inset-0 bg-[#FF8A65]/20 rounded-full animate-ping" />
          <div className="relative w-24 h-24 rounded-full bg-gradient-to-br from-[#FF8A65] to-[#FF7043] flex items-center justify-center text-white text-3xl font-bold shadow-xl border-4 border-white">
            AI
          </div>
          {isTyping && (
             <div className="absolute -bottom-2 -right-2 bg-white px-3 py-1 rounded-full text-xs font-bold text-gray-500 shadow-md flex gap-1">
               <span className="animate-bounce">.</span>
               <span className="animate-bounce delay-100">.</span>
               <span className="animate-bounce delay-200">.</span>
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
              className="text-center space-y-4"
            >
              {getQuestionText().split('\n').map((line, i) => (
                <p key={i} className="text-xl md:text-2xl font-bold text-gray-800 leading-relaxed">
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
              {currentQuestion.type === 'text' ? (
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
                    className="py-6 text-lg rounded-2xl border-gray-200 focus:border-[#FF8A65] focus:ring-[#FF8A65]/20"
                  />
                  <Button 
                    type="submit" 
                    disabled={!inputValue.trim()}
                    className="h-14 w-14 rounded-2xl bg-[#333] hover:bg-black text-white shrink-0"
                  >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" /></svg>
                  </Button>
                </form>
              ) : (
                <div className="flex flex-col gap-3">
                  {currentQuestion.options?.map((option) => (
                    <Button
                      key={option.value}
                      variant="outline"
                      onClick={() => handleAnswer(option.value)}
                      className="w-full py-6 text-lg rounded-2xl border-gray-200 hover:bg-[#FF8A65] hover:text-white hover:border-[#FF8A65] transition-all duration-300 font-bold text-gray-600 justify-between group px-6"
                    >
                      {option.label}
                      <svg className="w-5 h-5 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4" /></svg>
                    </Button>
                  ))}
                </div>
              )}
              
              {/* Custom Stats Input */}
              {currentQuestion.type === 'custom_stats' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-bold text-gray-500 block mb-1">年齢</label>
                      <Input 
                        type="number" 
                        placeholder="25" 
                        className="py-6 rounded-xl text-center text-lg"
                        onChange={(e) => setAnswers({...answers, age: e.target.value})}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-bold text-gray-500 block mb-1">職業</label>
                      <Input 
                        type="text" 
                        placeholder="会社員" 
                        className="py-6 rounded-xl text-center text-lg"
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
                        className="py-6 rounded-xl text-center text-lg"
                        onChange={(e) => setAnswers({...answers, height: e.target.value})}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-bold text-gray-500 block mb-1">体重 (kg)</label>
                      <Input 
                        type="number" 
                        placeholder="60" 
                        className="py-6 rounded-xl text-center text-lg"
                        onChange={(e) => setAnswers({...answers, weight: e.target.value})}
                      />
                    </div>
                  </div>
                  <Button 
                    onClick={() => handleAnswer("completed")}
                    disabled={!answers.age || !answers.occupation || !answers.height || !answers.weight}
                    className="w-full py-6 rounded-full bg-[#333] hover:bg-black text-white font-bold mt-4"
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
