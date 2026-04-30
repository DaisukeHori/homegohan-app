"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { motion, AnimatePresence } from "framer-motion";

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
    id: 'target_weight',
    text: '目標体重を教えてください',
    type: 'number',
    placeholder: '例: 55',
    min: 30,
    max: 200,
    showIf: (answers: Record<string, any>) =>
      answers.nutrition_goal === 'lose_weight' || answers.nutrition_goal === 'gain_muscle',
  },
  // Performance OS v3: アスリート向け追加質問
  {
    id: 'sport_type',
    text: '主に取り組んでいる競技は？',
    type: 'choice',
    showIf: (answers: Record<string, any>) => answers.nutrition_goal === 'athlete_performance',
    options: [
      { label: '⚽ サッカー', value: 'soccer' },
      { label: '🏀 バスケットボール', value: 'basketball' },
      { label: '🏐 バレーボール', value: 'volleyball' },
      { label: '⚾ 野球', value: 'baseball' },
      { label: '🎾 テニス', value: 'tennis' },
      { label: '🏊 水泳', value: 'swimming' },
      { label: '🏃 陸上競技', value: 'track_and_field' },
      { label: '🚴 自転車', value: 'road_cycling' },
      { label: '🥊 格闘技', value: 'martial_arts_general' },
      { label: '🏋️ ウェイトリフティング', value: 'weightlifting' },
      { label: '🎯 その他', value: 'custom' },
    ]
  },
  {
    id: 'sport_custom_name',
    text: '競技名を入力してください',
    type: 'text',
    placeholder: '例: トライアスロン',
    showIf: (answers: Record<string, any>) =>
      answers.nutrition_goal === 'athlete_performance' && answers.sport_type === 'custom',
  },
  {
    id: 'sport_experience',
    text: '競技経験はどのくらいですか？',
    type: 'choice',
    showIf: (answers: Record<string, any>) => answers.nutrition_goal === 'athlete_performance',
    options: [
      { label: '🔰 初心者（1年未満）', value: 'beginner', description: '始めたばかり' },
      { label: '📈 中級者（1〜3年）', value: 'intermediate', description: '基礎は身についている' },
      { label: '🏆 上級者（3年以上）', value: 'advanced', description: '競技会・大会出場レベル' },
    ]
  },
  {
    id: 'training_phase',
    text: '現在のトレーニング期は？',
    type: 'choice',
    showIf: (answers: Record<string, any>) => answers.nutrition_goal === 'athlete_performance',
    options: [
      { label: '🏋️ トレーニング期', value: 'training', description: '体力・技術向上中' },
      { label: '🏆 試合期', value: 'competition', description: '大会・試合シーズン' },
      { label: '⚖️ 減量期', value: 'cut', description: '体重調整中（階級制など）' },
      { label: '🛌 回復期', value: 'recovery', description: 'オフシーズン・ケガからの復帰' },
    ]
  },
  {
    id: 'competition_date',
    text: '次の大会・試合はいつですか？',
    type: 'date',
    showIf: (answers: Record<string, any>) =>
      answers.nutrition_goal === 'athlete_performance' &&
      (answers.training_phase === 'competition' || answers.training_phase === 'cut'),
    allowSkip: true,
  },
  {
    id: 'target_date',
    text: 'いつまでに達成したいですか？',
    type: 'date',
    showIf: (answers: Record<string, any>) =>
      answers.nutrition_goal === 'lose_weight' || answers.nutrition_goal === 'gain_muscle',
    allowSkip: true,
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
      { label: '🌿 便秘・下痢', value: '消化器系' },
      { label: '😪 不眠・睡眠障害', value: '睡眠障害' },
      { label: '🤧 花粉症・アレルギー', value: 'アレルギー' },
      { label: '🌡️ 甲状腺疾患', value: '甲状腺疾患' },
      { label: '🧠 自律神経失調', value: '自律神経' },
      { label: '😰 うつ・不安障害', value: 'メンタル' },
    ],
    allowSkip: true,
  },
  {
    id: 'body_concerns',
    text: '体の悩みはありますか？\n（複数選択可、なければスキップ）',
    type: 'multi_choice',
    allowSkip: true,
    options: [
      { label: '🥶 冷え性', value: 'cold_sensitivity' },
      { label: '🦵 むくみやすい', value: 'swelling_prone' },
      { label: '💤 疲れやすい', value: 'fatigue' },
      { label: '🤕 肩こり・腰痛', value: 'stiff_shoulders' },
      { label: '😵 頭痛持ち', value: 'headache' },
      { label: '🌡️ 汗をかきにくい', value: 'low_sweating' },
      { label: '🍂 肌荒れ', value: 'skin_trouble' },
      { label: '💇 髪のパサつき', value: 'dry_hair' },
    ],
  },
  {
    id: 'sleep_quality',
    text: '睡眠の質はいかがですか？',
    type: 'choice',
    options: [
      { label: '😴 良好', value: 'good', description: 'よく眠れている' },
      { label: '😐 普通', value: 'average', description: '特に問題なし' },
      { label: '😫 悪い', value: 'poor', description: '睡眠に問題がある' },
    ]
  },
  {
    id: 'stress_level',
    text: '日々のストレスレベルは？',
    type: 'choice',
    options: [
      { label: '😌 低い', value: 'low', description: 'リラックスできている' },
      { label: '😐 普通', value: 'medium', description: '日常的なストレス' },
      { label: '😰 高い', value: 'high', description: 'ストレスを感じている' },
    ]
  },
  {
    id: 'pregnancy_status',
    text: '妊娠・授乳の状況を教えてください',
    type: 'choice',
    showIf: (answers: Record<string, any>) => answers.gender === 'female',
    options: [
      { label: '🙅‍♀️ 該当なし', value: 'none', description: '妊娠・授乳中ではない' },
      { label: '🤰 妊娠中', value: 'pregnant', description: '現在妊娠中' },
      { label: '🤱 授乳中', value: 'nursing', description: '現在授乳中' },
    ]
  },
  {
    id: 'medications',
    text: '服用中の薬はありますか？\n（食事に影響するものを選択、なければスキップ）',
    type: 'multi_choice',
    options: [
      { label: '💊 ワーファリン（血液サラサラ）', value: 'warfarin' },
      { label: '💊 降圧剤', value: 'antihypertensive' },
      { label: '💊 糖尿病薬', value: 'diabetes_medication' },
      { label: '💊 利尿剤', value: 'diuretic' },
      { label: '💊 抗生物質', value: 'antibiotics' },
      { label: '💊 ステロイド', value: 'steroid' },
    ],
    allowSkip: true,
  },
  {
    id: 'allergies',
    text: '食物アレルギーはありますか？\n（なければスキップ）',
    type: 'tags',
    placeholder: '例: 卵、エビ、小麦',
    suggestions: ['卵', 'エビ', 'カニ', '小麦', '乳製品', 'そば', '落花生', 'ナッツ類', '貝類', '魚卵', '大豆'],
    allowSkip: true,
  },
  {
    id: 'dislikes',
    text: '苦手な食材はありますか？\n（アレルギー以外で避けたいもの）',
    type: 'tags',
    placeholder: '例: ピーマン、セロリ、レバー',
    suggestions: ['ピーマン', 'セロリ', 'パクチー', 'レバー', 'ホルモン', 'なす', 'ゴーヤ', 'しいたけ', '納豆', 'グリンピース', 'にんじん', 'トマト'],
    allowSkip: true,
  },
  {
    id: 'favorite_ingredients',
    text: '好きな食材を教えてください\n（献立に積極的に入れます）',
    type: 'tags',
    placeholder: '例: 鶏肉、ブロッコリー、アボカド',
    suggestions: ['鶏肉', '豚肉', '牛肉', '魚', 'エビ', '豆腐', '卵', 'ブロッコリー', 'ほうれん草', 'トマト', 'アボカド', 'きのこ', 'さつまいも', 'キャベツ'],
    allowSkip: true,
  },
  {
    id: 'diet_style',
    text: '食事スタイルを教えてください',
    type: 'choice',
    allowSkip: true,
    options: [
      { label: '🍽️ 通常', value: 'normal', description: '特に制限なし' },
      { label: '🥬 ベジタリアン', value: 'vegetarian', description: '肉を食べない' },
      { label: '🌱 ヴィーガン', value: 'vegan', description: '動物性食品を食べない' },
      { label: '🐟 ペスカタリアン', value: 'pescatarian', description: '魚は食べる' },
      { label: '🌾 グルテンフリー', value: 'gluten_free', description: '小麦を避ける' },
      { label: '🥑 ケトジェニック', value: 'keto', description: '低糖質・高脂質' },
    ]
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
    text: '何人分の食事を作りますか？\n（1〜10人）',
    type: 'number',
    placeholder: '例: 4',
    min: 1,
    max: 10,
  },
  {
    id: 'servings_config',
    text: '曜日ごとの食事人数を設定してください\n（0人＝作らない/外食）',
    type: 'servings_grid',
  },
  {
    id: 'shopping_frequency',
    text: '普段の買い物の頻度は？',
    type: 'choice',
    options: [
      { label: '🛒 毎日買い物に行く', value: 'daily' },
      { label: '🛒 週2〜3回', value: '2-3_weekly' },
      { label: '🛒 週1回まとめ買い', value: 'weekly' },
      { label: '🛒 2週間に1回程度', value: 'biweekly' },
    ],
  },
  {
    id: 'weekly_food_budget',
    text: '週の食費予算は？\n（任意）',
    type: 'choice',
    allowSkip: true,
    options: [
      { label: '💰 〜5,000円', value: '5000' },
      { label: '💰 5,000〜10,000円', value: '10000' },
      { label: '💰 10,000〜15,000円', value: '15000' },
      { label: '💰 15,000〜20,000円', value: '20000' },
      { label: '💰 20,000円以上', value: '25000' },
      { label: '🤷 特に決めていない', value: 'none' },
    ],
  },
  {
    id: 'kitchen_appliances',
    text: 'お持ちの調理器具は？\n（複数選択可、スキップ可）',
    type: 'multi_choice',
    allowSkip: true,
    options: [
      { label: '🔥 オーブン/オーブンレンジ', value: 'oven' },
      { label: '🐟 魚焼きグリル', value: 'grill' },
      { label: '⏱️ 圧力鍋', value: 'pressure_cooker' },
      { label: '🤖 ホットクック/電気圧力鍋', value: 'slow_cooker' },
      { label: '🍟 エアフライヤー', value: 'air_fryer' },
      { label: '🥤 フードプロセッサー/ミキサー', value: 'food_processor' },
    ],
  },
  {
    id: 'stove_type',
    text: 'お使いのコンロは？',
    type: 'choice',
    options: [
      { label: '🔥 ガスコンロ', value: 'stove:gas' },
      { label: '⚡ IHコンロ', value: 'stove:ih' },
    ],
  },
  {
    id: 'hobbies',
    text: '趣味を教えてください\n（献立提案の参考にします）',
    type: 'tags',
    placeholder: '例: 読書、ヨガ、ランニング',
    suggestions: ['読書', '料理', 'ヨガ', 'ランニング', '筋トレ', 'サイクリング', '登山', '映画', 'ゲーム', '旅行', '音楽', 'カフェ巡り', '釣り', 'キャンプ'],
    allowSkip: true,
  },
];

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
  const numberMin = isNumberQuestion && typeof (currentQuestion as any).min === 'number' ? (currentQuestion as any).min : 1;
  const numberMax = isNumberQuestion && typeof (currentQuestion as any).max === 'number' ? (currentQuestion as any).max : 10;
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
  const saveProgress = async (step: number, ans: Record<string, any>) => {
    const totalQuestions = calculateTotalQuestions(ans);
    try {
      setIsSaving(true);
      await fetch('/api/onboarding/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentStep: step,
          answers: ans,
          totalQuestions,
        }),
      });
    } catch (error) {
      console.error('Failed to save progress:', error);
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

    const newAnswers = { ...answers, [currentQuestion.id]: value };
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

      // 完了処理
      try {
        await fetch('/api/onboarding/complete', { method: 'POST' });
      } catch (e) {
        console.error(e);
      }

      setTimeout(() => {
        router.push("/onboarding/complete");
      }, 2500);
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
                      !answers.age ||
                      !answers.height || Number(answers.height) < 50 || Number(answers.height) > 250 ||
                      !answers.weight || Number(answers.weight) < 10 || Number(answers.weight) > 200
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
                      const config = answers.servings_config || createDefaultServingsConfig(familySize);
                      handleAnswer(config);
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
