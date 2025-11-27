"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, AnimatePresence, useInView } from "framer-motion";
import { 
  Camera, Sparkles, ChefHat, TrendingUp, Award, Heart, 
  Clock, Zap, Target, Users, Star, ChevronDown, ChevronRight,
  Check, Play, ArrowRight, Flame, Moon, Sun, Coffee,
  Scale, Activity, Trophy, Calendar, BookOpen, ShoppingCart,
  MessageCircle, ThumbsUp, Utensils, Leaf, Apple, Quote
} from "lucide-react";

// カラーパレット
const colors = {
  primary: '#E07A5F',
  primaryLight: '#FDF0ED',
  primaryDark: '#C96A52',
  secondary: '#3D5A80',
  secondaryLight: '#E8EEF4',
  accent: '#98C1D9',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#F4A261',
  warningLight: '#FEF6EE',
  purple: '#7C6BA0',
  purpleLight: '#F3F0F7',
  bg: '#FAF9F7',
  bgAlt: '#F5F3EF',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#8A8A8A',
  border: '#E8E8E8',
};

// サンプルデータ
const sampleMeals = [
  {
    id: 1,
    image: "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400",
    name: "彩り野菜のサラダボウル",
    score: 95,
    comment: "わぁ、すごい彩り！アボカドの良質な脂質と、たっぷりの野菜でビタミンもバッチリですね。見た目も美しくて、食べるのがもったいないくらい✨",
    nutrients: { cal: 380, protein: 12, carbs: 28, fat: 22, veg: 95 },
    tips: "アボカドは「森のバター」と呼ばれるほど栄養豊富。ビタミンEで美肌効果も期待できます！"
  },
  {
    id: 2,
    image: "https://images.unsplash.com/photo-1547592180-85f173990554?w=400",
    name: "和風定食",
    score: 92,
    comment: "これぞ日本の食卓！焼き魚のDHAが脳を活性化、お味噌汁の発酵パワーで腸内環境もバッチリ。おばあちゃんも喜ぶ、ほっとする一品ですね😊",
    nutrients: { cal: 520, protein: 28, carbs: 45, fat: 18, veg: 80 },
    tips: "味噌は「医者いらず」と言われる発酵食品。毎日の味噌汁で免疫力アップ！"
  },
  {
    id: 3,
    image: "https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=400",
    name: "トマトパスタ",
    score: 88,
    comment: "トマトのリコピンがたっぷり！オリーブオイルと一緒に摂ることで吸収率が3倍になるんですよ。イタリアンマンマも納得の一皿🍝",
    nutrients: { cal: 620, protein: 18, carbs: 72, fat: 24, veg: 70 },
    tips: "リコピンは加熱すると吸収率UP。トマトソースは生トマトより栄養価が高いんです！"
  }
];

const userReviews = [
  { name: "みさき", age: "32歳", job: "IT企業", avatar: "👩‍💻", rating: 5, text: "写真撮るだけなのに、こんなに詳しく分析してくれるなんて感動。しかも褒めてくれるから嬉しくて続けられる！", result: "-4.2kg / 3ヶ月" },
  { name: "けんた", age: "28歳", job: "営業", avatar: "👨‍💼", rating: 5, text: "献立考えるのが苦手だったけど、AIが提案してくれるから楽。週末の作り置きが習慣になりました。", result: "自炊率0%→70%" },
  { name: "ゆうこ", age: "45歳", job: "主婦", avatar: "👩‍🍳", rating: 5, text: "家族4人分の栄養管理が簡単に。子供たちも「今日のスコア何点？」って聞いてくるように（笑）", result: "野菜摂取量2倍" },
  { name: "たくや", age: "35歳", job: "エンジニア", avatar: "👨‍💻", rating: 5, text: "カロリー計算とか面倒で続かなかったけど、これは写真だけでOK。ズボラな自分でも3ヶ月続いてる。", result: "連続記録89日" },
  { name: "あやか", age: "26歳", job: "看護師", avatar: "👩‍⚕️", rating: 5, text: "夜勤明けの食事が乱れがちだったけど、記録するようになって意識が変わった。体調も良くなった気がする。", result: "体調スコア+30%" },
  { name: "しんじ", age: "52歳", job: "経営者", avatar: "👨‍💼", rating: 5, text: "健康診断の数値が気になって始めた。妻と一緒に使ってるけど、食事の会話が増えたのが嬉しい。", result: "血圧-15mmHg" },
];

const mediaLogos = ["日経新聞", "東洋経済", "Forbes", "TechCrunch", "NewsPicks", "Wired"];

const features = [
  { icon: <Camera size={24} />, title: "写真で記録", desc: "撮るだけでAIが自動分析", detail: "面倒なカロリー入力は不要。写真を撮るだけで、AIが食材を認識し、栄養素を瞬時に計算します。", color: colors.primary },
  { icon: <Sparkles size={24} />, title: "AIが褒める", desc: "ポジティブなフィードバック", detail: "ダメ出しじゃなく、良いところを見つけて褒める。だから続けられる、だから楽しい。", color: colors.warning },
  { icon: <ChefHat size={24} />, title: "献立提案", desc: "1週間分を自動生成", detail: "「今日何食べよう」の悩みを解消。あなたの好みと栄養状態に合わせて最適な献立を提案。", color: colors.success },
  { icon: <Scale size={24} />, title: "健康記録", desc: "体重・睡眠・気分を記録", detail: "食事だけじゃない。体重、睡眠、気分も記録して、トータルで健康をサポート。", color: colors.secondary },
  { icon: <Trophy size={24} />, title: "バッジ収集", desc: "達成感でモチベUP", detail: "目標達成でバッジをゲット。コレクションが増えるほど、自信がつく。", color: colors.purple },
  { icon: <ShoppingCart size={24} />, title: "買い物リスト", desc: "献立から自動作成", detail: "献立が決まれば買い物リストも自動生成。スーパーで迷わない。", color: colors.primary },
  { icon: <TrendingUp size={24} />, title: "週次レポート", desc: "AIが食生活を分析", detail: "1週間の食事をAIが振り返り。改善ポイントと褒めポイントをお届け。", color: colors.success },
  { icon: <Users size={24} />, title: "家族で共有", desc: "みんなの健康を管理", detail: "家族の食事も一緒に管理。子供の成長、親の健康、みんなをサポート。", color: colors.warning },
];

const badges = [
  { icon: "🌅", name: "朝食マスター", desc: "朝食を7日連続記録", color: colors.warning },
  { icon: "🔥", name: "7日連続", desc: "1週間毎日記録達成", color: colors.primary },
  { icon: "🥗", name: "野菜マニア", desc: "野菜スコア90以上を10回", color: colors.success },
  { icon: "👨‍🍳", name: "自炊デビュー", desc: "初めての自炊記録", color: colors.secondary },
  { icon: "🌙", name: "夜更かし撃退", desc: "夜食を3日連続回避", color: colors.purple },
  { icon: "💪", name: "タンパク質王", desc: "タンパク質目標を7日達成", color: colors.primary },
  { icon: "🎯", name: "目標達成", desc: "設定した目標を達成", color: colors.success },
  { icon: "👑", name: "マスターシェフ", desc: "30日連続自炊達成", color: '#FFD700' },
  { icon: "🏃", name: "アクティブ", desc: "運動記録を7日連続", color: colors.secondary },
  { icon: "😴", name: "快眠王", desc: "睡眠スコア90以上を7日", color: colors.purple },
  { icon: "🍎", name: "フルーツ好き", desc: "フルーツを7日連続摂取", color: colors.primary },
  { icon: "💧", name: "水分補給", desc: "水2L以上を7日達成", color: colors.accent },
];

const faqs = [
  { q: "本当に無料で使えますか？", a: "はい！基本機能は完全無料です。写真撮影、AI分析、献立提案、健康記録などすべてお使いいただけます。将来的にプレミアム機能を追加予定ですが、現在の機能は永久無料でご利用いただけます。課金を迫ることは一切ありませんのでご安心ください。" },
  { q: "どんな写真を撮ればいいですか？", a: "食事全体が写っていれば大丈夫です！真上からでも斜めからでもOK。自然光で撮ると認識精度が上がります。お店のメニュー写真や、インスタ映えを狙った写真でも問題なく分析できますよ。" },
  { q: "データは安全ですか？", a: "もちろんです。すべてのデータは暗号化して保存され、第三者に共有されることはありません。あなたの食事写真や健康データは、あなただけのもの。いつでもデータの削除をリクエストできます。" },
  { q: "家族で使えますか？", a: "現在は個人アカウントのみですが、家族プラン機能を開発中です！お子様や高齢のご家族の食事管理にも使いやすい機能を準備しています。リリースをお楽しみに。" },
  { q: "AIの分析は正確ですか？", a: "最新のAI技術を使用しており、一般的な料理であれば90%以上の精度で認識できます。ただし、あくまで推定値ですので、医療目的での使用はお控えください。日々の食生活の参考としてお使いいただくのがベストです。" },
  { q: "オフラインでも使えますか？", a: "写真の撮影と保存はオフラインでも可能です。AI分析や献立提案にはインターネット接続が必要ですが、接続時に自動で同期されるので、電波の悪い場所でも安心です。" },
];

const stats = [
  { value: "1,234,567", label: "食の分析実績", suffix: "+", icon: <Camera size={20} /> },
  { value: "98.7", label: "継続率", suffix: "%", icon: <Heart size={20} /> },
  { value: "42", label: "最長連続記録", suffix: "日", icon: <Flame size={20} /> },
  { value: "4.9", label: "App Store評価", suffix: "", icon: <Star size={20} /> },
];

// カウントアップフック
const useCountUp = (end: number, duration: number = 2000) => {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true });
  const hasStarted = useRef(false);

  useEffect(() => {
    if (!isInView || hasStarted.current) return;
    hasStarted.current = true;
    let startTime: number;
    const animate = (currentTime: number) => {
      if (!startTime) startTime = currentTime;
      const progress = Math.min((currentTime - startTime) / duration, 1);
      setCount(progress * end);
      if (progress < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }, [end, duration, isInView]);

  return { count, ref };
};

export default function LandingPage() {
  const [selectedMeal, setSelectedMeal] = useState<number | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisComplete, setAnalysisComplete] = useState(false);
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);
  const [activeFeature, setActiveFeature] = useState(0);
  const [scrollY, setScrollY] = useState(0);

  useEffect(() => {
    const handleScroll = () => setScrollY(window.scrollY);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleMealSelect = (id: number) => {
    setSelectedMeal(id);
    setIsAnalyzing(true);
    setAnalysisComplete(false);
    setTimeout(() => {
      setIsAnalyzing(false);
      setAnalysisComplete(true);
    }, 1800);
  };

  const selectedMealData = sampleMeals.find(m => m.id === selectedMeal);

  return (
    <div className="relative w-full min-h-screen overflow-x-hidden" style={{ background: colors.bg }}>
      
      {/* 背景デコレーション */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden opacity-40">
        <div className="absolute w-[600px] h-[600px] rounded-full blur-3xl" style={{ background: colors.primaryLight, top: '-10%', left: '-5%' }} />
        <div className="absolute w-[500px] h-[500px] rounded-full blur-3xl" style={{ background: colors.secondaryLight, top: '30%', right: '-10%' }} />
        <div className="absolute w-[400px] h-[400px] rounded-full blur-3xl" style={{ background: colors.successLight, bottom: '10%', left: '20%' }} />
      </div>

      {/* ヘッダー */}
      <header className="fixed top-0 w-full z-50 transition-all duration-300" style={{ 
        background: scrollY > 50 ? 'rgba(255,255,255,0.95)' : 'transparent',
        backdropFilter: scrollY > 50 ? 'blur(20px)' : 'none',
        boxShadow: scrollY > 50 ? '0 2px 20px rgba(0,0,0,0.05)' : 'none',
      }}>
        <div className="container mx-auto px-4 md:px-6 h-16 md:h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-9 h-9 md:w-10 md:h-10 rounded-xl flex items-center justify-center text-white font-bold shadow-md" style={{ background: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.primaryDark} 100%)` }}>H</div>
            <span className="font-bold text-lg md:text-xl" style={{ color: colors.text }}>ほめゴハン</span>
          </Link>
          <div className="flex items-center gap-2 md:gap-4">
            <Link href="/login" className="hidden sm:block text-sm font-medium px-3 py-2 rounded-full hover:bg-gray-100 transition-colors" style={{ color: colors.textLight }}>ログイン</Link>
            <Link href="/signup">
              <motion.button className="text-sm font-bold px-4 md:px-6 py-2.5 text-white rounded-full shadow-lg" style={{ background: colors.text }} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                無料で始める
              </motion.button>
            </Link>
          </div>
        </div>
      </header>

      {/* ========== ヒーローセクション ========== */}
      <section className="relative pt-24 md:pt-32 pb-16 md:pb-24">
        <div className="container mx-auto px-4 md:px-6">
          
          {/* キャッチコピー */}
          <motion.div className="text-center max-w-4xl mx-auto mb-12" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold mb-6" style={{ background: colors.primaryLight, color: colors.primary }}>
              <span className="relative flex h-2 w-2"><span className="animate-ping absolute h-full w-full rounded-full opacity-75" style={{ background: colors.primary }} /><span className="relative rounded-full h-2 w-2" style={{ background: colors.primary }} /></span>
              🎉 10万人が使ってる食事管理アプリ
            </div>
            <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold leading-tight mb-6" style={{ color: colors.text }}>
              食べることを、<br />
              <span className="text-transparent bg-clip-text" style={{ backgroundImage: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.warning} 100%)` }}>もっと誇らしく。</span>
            </h1>
            <p className="text-lg md:text-xl leading-relaxed mb-8 max-w-2xl mx-auto" style={{ color: colors.textLight }}>
              写真を撮るだけで、AIがあなたの食事を分析。<br />
              ダメ出しじゃなく、<strong style={{ color: colors.primary }}>良いところを見つけて褒める</strong>。<br />
              だから、続けられる。だから、楽しい。
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center mb-8">
              <Link href="/signup">
                <motion.button className="w-full sm:w-auto px-8 py-4 text-white font-bold rounded-full shadow-xl flex items-center justify-center gap-2" style={{ background: colors.primary }} whileHover={{ scale: 1.03, boxShadow: `0 20px 40px ${colors.primary}40` }} whileTap={{ scale: 0.98 }}>
                  <Sparkles size={20} />無料で始める（30秒で登録）
                </motion.button>
              </Link>
              <motion.button onClick={() => document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth' })} className="w-full sm:w-auto px-8 py-4 font-bold rounded-full flex items-center justify-center gap-2" style={{ background: colors.card, color: colors.textLight, border: `2px solid ${colors.border}` }} whileHover={{ borderColor: colors.primary, color: colors.primary }} whileTap={{ scale: 0.98 }}>
                <Play size={18} />デモを体験してみる
              </motion.button>
            </div>
            <div className="flex flex-wrap justify-center gap-4 md:gap-6 text-sm" style={{ color: colors.textMuted }}>
              <span className="flex items-center gap-1.5"><Check size={16} style={{ color: colors.success }} />完全無料</span>
              <span className="flex items-center gap-1.5"><Check size={16} style={{ color: colors.success }} />カード登録不要</span>
              <span className="flex items-center gap-1.5"><Check size={16} style={{ color: colors.success }} />1分で使い始められる</span>
              <span className="flex items-center gap-1.5"><Check size={16} style={{ color: colors.success }} />いつでも退会OK</span>
            </div>
          </motion.div>

          {/* 実績バー */}
          <motion.div className="flex flex-wrap justify-center gap-4 md:gap-8 mb-16" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
            {stats.map((stat, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3 rounded-2xl" style={{ background: colors.card, boxShadow: '0 2px 12px rgba(0,0,0,0.04)' }}>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: colors.primaryLight, color: colors.primary }}>{stat.icon}</div>
                <div>
                  <div className="text-xl md:text-2xl font-bold" style={{ color: colors.text }}>{stat.value}{stat.suffix}</div>
                  <div className="text-xs" style={{ color: colors.textMuted }}>{stat.label}</div>
                </div>
              </div>
            ))}
          </motion.div>

          {/* AIデモ体験 */}
          <motion.div id="demo" className="max-w-5xl mx-auto" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
            <div className="text-center mb-8">
              <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold" style={{ background: colors.successLight, color: colors.success }}>
                <Sparkles size={16} />今すぐ体験！AIデモ
              </span>
            </div>
            
            <div className="grid md:grid-cols-2 gap-6 md:gap-8">
              {/* 左: 写真選択 */}
              <div className="p-6 rounded-3xl" style={{ background: colors.card, boxShadow: '0 4px 24px rgba(0,0,0,0.06)' }}>
                <h3 className="text-lg font-bold mb-2" style={{ color: colors.text }}>📸 食事の写真を選んでみて</h3>
                <p className="text-sm mb-4" style={{ color: colors.textMuted }}>タップするとAIが分析を始めます</p>
                <div className="grid grid-cols-3 gap-3">
                  {sampleMeals.map((meal) => (
                    <motion.button key={meal.id} onClick={() => handleMealSelect(meal.id)} className="relative aspect-square rounded-2xl overflow-hidden group" style={{ border: selectedMeal === meal.id ? `3px solid ${colors.primary}` : `2px solid ${colors.border}` }} whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                      <Image src={meal.image} alt={meal.name} fill className="object-cover" unoptimized />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                        {selectedMeal === meal.id && <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: colors.primary }}><Check size={18} color="white" /></div>}
                      </div>
                      <div className="absolute bottom-0 inset-x-0 p-2 bg-gradient-to-t from-black/60 to-transparent">
                        <p className="text-white text-xs font-medium truncate">{meal.name}</p>
                      </div>
                    </motion.button>
                  ))}
                </div>
                <p className="text-xs text-center mt-4" style={{ color: colors.textMuted }}>※ 実際のアプリではあなたの食事写真を分析します</p>
              </div>

              {/* 右: 分析結果 */}
              <div className="p-6 rounded-3xl" style={{ background: colors.card, boxShadow: '0 4px 24px rgba(0,0,0,0.06)' }}>
                <h3 className="text-lg font-bold mb-2" style={{ color: colors.text }}>🤖 AIの分析結果</h3>
                <p className="text-sm mb-4" style={{ color: colors.textMuted }}>AIがあなたの食事を褒めます</p>
                
                <AnimatePresence mode="wait">
                  {isAnalyzing && (
                    <motion.div key="analyzing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="p-8 rounded-2xl text-center" style={{ background: colors.bgAlt }}>
                      <motion.div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ background: colors.primary }} animate={{ rotate: 360 }} transition={{ duration: 2, repeat: Infinity, ease: "linear" }}>
                        <Sparkles size={28} color="white" />
                      </motion.div>
                      <p className="font-bold mb-2" style={{ color: colors.text }}>AIが分析中...</p>
                      <p className="text-sm mb-4" style={{ color: colors.textMuted }}>食材を認識して栄養素を計算しています</p>
                      <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: colors.border }}>
                        <motion.div className="h-full rounded-full" style={{ background: colors.primary }} initial={{ width: 0 }} animate={{ width: '100%' }} transition={{ duration: 1.8 }} />
                      </div>
                    </motion.div>
                  )}

                  {analysisComplete && selectedMealData && (
                    <motion.div key="result" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                      {/* スコア */}
                      <div className="flex items-center gap-4 mb-4 p-4 rounded-2xl" style={{ background: colors.successLight }}>
                        <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-bold text-white" style={{ background: colors.success }}>{selectedMealData.score}</div>
                        <div>
                          <p className="font-bold" style={{ color: colors.success }}>素晴らしい！🎉</p>
                          <p className="text-sm" style={{ color: colors.textLight }}>{selectedMealData.name}</p>
                        </div>
                      </div>
                      
                      {/* AIコメント */}
                      <div className="p-4 rounded-2xl mb-4" style={{ background: colors.primaryLight }}>
                        <div className="flex items-start gap-3">
                          <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: colors.primary }}><Sparkles size={16} color="white" /></div>
                          <div>
                            <p className="text-sm font-bold mb-1" style={{ color: colors.primary }}>AIからのコメント</p>
                            <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>{selectedMealData.comment}</p>
                          </div>
                        </div>
                      </div>

                      {/* 栄養素 */}
                      <div className="grid grid-cols-5 gap-2 mb-4">
                        {[
                          { label: 'カロリー', value: selectedMealData.nutrients.cal, unit: 'kcal', color: colors.primary },
                          { label: 'タンパク質', value: selectedMealData.nutrients.protein, unit: 'g', color: colors.secondary },
                          { label: '炭水化物', value: selectedMealData.nutrients.carbs, unit: 'g', color: colors.warning },
                          { label: '脂質', value: selectedMealData.nutrients.fat, unit: 'g', color: colors.purple },
                          { label: '野菜', value: selectedMealData.nutrients.veg, unit: '点', color: colors.success },
                        ].map((n, i) => (
                          <div key={i} className="p-2 rounded-xl text-center" style={{ background: colors.bgAlt }}>
                            <p className="text-[10px] mb-0.5" style={{ color: colors.textMuted }}>{n.label}</p>
                            <p className="text-sm font-bold" style={{ color: n.color }}>{n.value}</p>
                            <p className="text-[10px]" style={{ color: colors.textMuted }}>{n.unit}</p>
                          </div>
                        ))}
                      </div>

                      {/* 豆知識 */}
                      <div className="p-3 rounded-xl flex items-start gap-2" style={{ background: colors.warningLight }}>
                        <Leaf size={16} style={{ color: colors.warning }} className="flex-shrink-0 mt-0.5" />
                        <p className="text-xs leading-relaxed" style={{ color: colors.textLight }}>
                          <strong style={{ color: colors.warning }}>💡 豆知識:</strong> {selectedMealData.tips}
                        </p>
                      </div>
                    </motion.div>
                  )}

                  {!isAnalyzing && !analysisComplete && (
                    <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-12 rounded-2xl text-center" style={{ background: colors.bgAlt, border: `2px dashed ${colors.border}` }}>
                      <Camera size={40} className="mx-auto mb-4" style={{ color: colors.textMuted }} />
                      <p className="font-medium mb-1" style={{ color: colors.textLight }}>左の写真をタップしてね</p>
                      <p className="text-sm" style={{ color: colors.textMuted }}>AIが食事を分析して褒めてくれます</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ========== メディア掲載 ========== */}
      <section className="py-12 border-y" style={{ background: colors.card, borderColor: colors.border }}>
        <div className="container mx-auto px-4 md:px-6">
          <p className="text-center text-sm font-medium mb-6" style={{ color: colors.textMuted }}>📰 メディア掲載実績</p>
          <div className="flex flex-wrap justify-center items-center gap-6 md:gap-12">
            {mediaLogos.map((logo, i) => (
              <span key={i} className="text-lg md:text-xl font-bold opacity-30 hover:opacity-60 transition-opacity" style={{ color: colors.text }}>{logo}</span>
            ))}
          </div>
        </div>
      </section>

      {/* ========== 3ステップ ========== */}
      <section className="py-20 md:py-32">
        <div className="container mx-auto px-4 md:px-6">
          <motion.div className="text-center max-w-2xl mx-auto mb-16" initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="text-3xl md:text-5xl font-bold mb-4" style={{ color: colors.text }}>
              使い方は、<span style={{ color: colors.primary }}>超カンタン。</span>
            </h2>
            <p className="text-lg" style={{ color: colors.textLight }}>難しい設定は一切なし。今日から始められます。</p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto relative">
            <div className="hidden md:block absolute top-16 left-[20%] right-[20%] h-0.5" style={{ background: colors.border }} />
            
            {[
              { step: 1, icon: <Camera size={32} />, title: '写真を撮る', desc: 'ご飯を食べる前にパシャッと一枚。それだけでOK！カロリー入力も食材選択も不要です。', color: colors.primary, emoji: '📸' },
              { step: 2, icon: <Sparkles size={32} />, title: 'AIが分析', desc: '最新のAIが食材を認識。カロリー、タンパク質、野菜スコアを瞬時に計算します。', color: colors.secondary, emoji: '🤖' },
              { step: 3, icon: <Heart size={32} />, title: '褒められる', desc: '「彩りが素敵！」「バランス最高！」AIが良いところを見つけて褒めてくれます。', color: colors.success, emoji: '🎉' },
            ].map((item, i) => (
              <motion.div key={i} className="relative text-center" initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.1 }}>
                <div className="relative z-10 mb-6">
                  <div className="w-20 h-20 mx-auto rounded-3xl flex items-center justify-center shadow-lg" style={{ background: colors.card, color: item.color }}>{item.icon}</div>
                  <div className="absolute -top-2 -right-2 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white" style={{ background: item.color }}>{item.step}</div>
                </div>
                <h3 className="text-xl font-bold mb-3" style={{ color: colors.text }}>{item.emoji} {item.title}</h3>
                <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>{item.desc}</p>
              </motion.div>
            ))}
          </div>

          <motion.div className="text-center mt-12" initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }}>
            <p className="text-lg mb-4" style={{ color: colors.textLight }}>たったこれだけで、食生活が変わります。</p>
            <Link href="/signup">
              <motion.button className="px-8 py-4 text-white font-bold rounded-full shadow-lg inline-flex items-center gap-2" style={{ background: colors.primary }} whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.98 }}>
                今すぐ無料で始める <ArrowRight size={18} />
              </motion.button>
            </Link>
          </motion.div>
        </div>
      </section>

      {/* ========== 機能紹介 ========== */}
      <section className="py-20 md:py-32" style={{ background: colors.bgAlt }}>
        <div className="container mx-auto px-4 md:px-6">
          <motion.div className="text-center max-w-2xl mx-auto mb-16" initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="text-3xl md:text-5xl font-bold mb-4" style={{ color: colors.text }}>
              <span style={{ color: colors.primary }}>8つの機能</span>で、<br />あなたの食生活を完全サポート。
            </h2>
            <p className="text-lg" style={{ color: colors.textLight }}>写真記録だけじゃない。献立提案から健康管理まで、全部入り。</p>
          </motion.div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 max-w-6xl mx-auto">
            {features.map((f, i) => (
              <motion.div key={i} className="p-5 rounded-2xl cursor-pointer group" style={{ background: colors.card, border: `1px solid ${colors.border}` }} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.05 }} whileHover={{ y: -5, boxShadow: '0 20px 40px rgba(0,0,0,0.08)' }} onClick={() => setActiveFeature(i)}>
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3 transition-transform group-hover:scale-110" style={{ background: `${f.color}15`, color: f.color }}>{f.icon}</div>
                <h3 className="font-bold mb-1" style={{ color: colors.text }}>{f.title}</h3>
                <p className="text-sm mb-2" style={{ color: colors.textMuted }}>{f.desc}</p>
                <p className="text-xs leading-relaxed" style={{ color: colors.textLight }}>{f.detail}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ========== 一日の流れ ========== */}
      <section className="py-20 md:py-32">
        <div className="container mx-auto px-4 md:px-6">
          <motion.div className="text-center max-w-2xl mx-auto mb-16" initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="text-3xl md:text-5xl font-bold mb-4" style={{ color: colors.text }}>
              AIと過ごす、<span style={{ color: colors.primary }}>1日の食事。</span>
            </h2>
            <p className="text-lg" style={{ color: colors.textLight }}>朝起きてから夜寝るまで、AIがあなたの食事を見守ります。</p>
          </motion.div>

          <div className="max-w-4xl mx-auto">
            {[
              { time: '7:00', icon: <Sun size={24} />, title: '朝食', meal: 'トーストと目玉焼き、サラダ', image: 'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=300', comment: 'おはようございます！🌅 卵のタンパク質で午前中の集中力バッチリ。サラダも添えて完璧な朝食ですね！', score: 88, color: colors.warning },
              { time: '12:30', icon: <Coffee size={24} />, title: '昼食', meal: '鶏むね肉のサラダボウル', image: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=300', comment: 'お昼ごはんお疲れさまです！🥗 高タンパク低脂質、ダイエット中の方にも最適な選択。午後も頑張れますね！', score: 94, color: colors.success },
              { time: '15:00', icon: <Apple size={24} />, title: 'おやつ', meal: 'ギリシャヨーグルトとフルーツ', image: 'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=300', comment: '素敵なおやつタイム！🍓 ヨーグルトの乳酸菌とフルーツのビタミンで、午後の疲れもリフレッシュ！', score: 91, color: colors.purple },
              { time: '19:00', icon: <Moon size={24} />, title: '夕食', meal: '鮭の塩焼き定食', image: 'https://images.unsplash.com/photo-1580822184713-fc5400e7fe10?w=300', comment: '今日の食事、トータルで素晴らしいバランスでした！✨ 鮭のDHAで明日も頭スッキリ。おやすみなさい🌙', score: 92, color: colors.secondary },
            ].map((item, i) => (
              <motion.div key={i} className="flex gap-4 md:gap-6 mb-8 last:mb-0" initial={{ opacity: 0, x: -30 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.1 }}>
                <div className="flex flex-col items-center">
                  <div className="w-12 h-12 md:w-14 md:h-14 rounded-2xl flex items-center justify-center flex-shrink-0" style={{ background: `${item.color}20`, color: item.color }}>{item.icon}</div>
                  {i < 3 && <div className="w-0.5 flex-1 my-2" style={{ background: colors.border }} />}
                </div>
                <div className="flex-1 pb-4">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-2xl font-bold" style={{ color: item.color }}>{item.time}</span>
                    <span className="font-medium" style={{ color: colors.text }}>{item.title}</span>
                    <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ background: colors.successLight, color: colors.success }}>スコア {item.score}</span>
                  </div>
                  <div className="p-4 rounded-2xl" style={{ background: colors.card, boxShadow: '0 2px 12px rgba(0,0,0,0.04)' }}>
                    <div className="flex gap-4">
                      <div className="w-20 h-20 md:w-24 md:h-24 rounded-xl overflow-hidden flex-shrink-0">
                        <Image src={item.image} alt={item.meal} width={96} height={96} className="object-cover w-full h-full" unoptimized />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold mb-2 truncate" style={{ color: colors.text }}>{item.meal}</p>
                        <div className="flex items-start gap-2">
                          <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: colors.primary }}><Sparkles size={12} color="white" /></div>
                          <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>{item.comment}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ========== バッジコレクション ========== */}
      <section className="py-20 md:py-32" style={{ background: colors.bgAlt }}>
        <div className="container mx-auto px-4 md:px-6">
          <motion.div className="text-center max-w-2xl mx-auto mb-12" initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="text-3xl md:text-5xl font-bold mb-4" style={{ color: colors.text }}>
              🏆 集めよう、<span style={{ color: colors.primary }}>あなたの勲章。</span>
            </h2>
            <p className="text-lg" style={{ color: colors.textLight }}>目標を達成するたびにバッジをゲット。全部集めたくなっちゃう！</p>
          </motion.div>

          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 md:gap-4 max-w-4xl mx-auto">
            {badges.map((badge, i) => (
              <motion.div key={i} className="p-4 rounded-2xl text-center group cursor-pointer" style={{ background: colors.card }} initial={{ opacity: 0, scale: 0.8 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true }} transition={{ delay: i * 0.03 }} whileHover={{ scale: 1.08, boxShadow: `0 10px 30px ${badge.color}30` }}>
                <div className="text-3xl md:text-4xl mb-2 group-hover:scale-110 transition-transform">{badge.icon}</div>
                <p className="text-xs font-bold mb-1 truncate" style={{ color: colors.text }}>{badge.name}</p>
                <p className="text-[10px] leading-tight" style={{ color: colors.textMuted }}>{badge.desc}</p>
              </motion.div>
            ))}
          </div>

          <motion.p className="text-center mt-8 text-sm" style={{ color: colors.textMuted }} initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }}>
            他にも50種類以上のバッジが！全部集められるかな？🎮
          </motion.p>
        </div>
      </section>

      {/* ========== ユーザーの声 ========== */}
      <section className="py-20 md:py-32">
        <div className="container mx-auto px-4 md:px-6">
          <motion.div className="text-center max-w-2xl mx-auto mb-16" initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="text-3xl md:text-5xl font-bold mb-4" style={{ color: colors.text }}>
              みんなの<span style={{ color: colors.primary }}>リアルな声。</span>
            </h2>
            <p className="text-lg" style={{ color: colors.textLight }}>実際に使っているユーザーさんの感想をご紹介します。</p>
          </motion.div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
            {userReviews.map((review, i) => (
              <motion.div key={i} className="p-6 rounded-3xl" style={{ background: colors.card, border: `1px solid ${colors.border}` }} initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.05 }}>
                {/* ヘッダー */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl" style={{ background: colors.bgAlt }}>{review.avatar}</div>
                    <div>
                      <p className="font-bold" style={{ color: colors.text }}>{review.name}</p>
                      <p className="text-xs" style={{ color: colors.textMuted }}>{review.age} / {review.job}</p>
                    </div>
                  </div>
                  <div className="flex gap-0.5">
                    {[...Array(review.rating)].map((_, j) => <Star key={j} size={14} fill={colors.warning} color={colors.warning} />)}
                  </div>
                </div>
                
                {/* コメント */}
                <div className="relative mb-4">
                  <Quote size={20} className="absolute -top-1 -left-1 opacity-20" style={{ color: colors.primary }} />
                  <p className="text-sm leading-relaxed pl-4" style={{ color: colors.textLight }}>{review.text}</p>
                </div>

                {/* 結果 */}
                <div className="p-3 rounded-xl flex items-center justify-between" style={{ background: colors.successLight }}>
                  <span className="text-xs font-medium" style={{ color: colors.textMuted }}>結果</span>
                  <span className="font-bold" style={{ color: colors.success }}>{review.result}</span>
                </div>
              </motion.div>
            ))}
          </div>

          <motion.div className="text-center mt-12" initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }}>
            <div className="inline-flex items-center gap-4 p-4 rounded-2xl" style={{ background: colors.card, boxShadow: '0 2px 12px rgba(0,0,0,0.04)' }}>
              <div className="flex -space-x-3">
                {['👩‍💻', '👨‍💼', '👩‍🍳', '👨‍💻', '👩‍⚕️'].map((emoji, i) => (
                  <div key={i} className="w-10 h-10 rounded-full flex items-center justify-center text-lg border-2 border-white" style={{ background: colors.bgAlt }}>{emoji}</div>
                ))}
              </div>
              <div className="text-left">
                <p className="font-bold" style={{ color: colors.text }}>10万人以上が利用中</p>
                <p className="text-xs" style={{ color: colors.textMuted }}>App Store評価 4.9 ⭐️</p>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ========== Before/After ストーリー ========== */}
      <section className="py-20 md:py-32" style={{ background: colors.bgAlt }}>
        <div className="container mx-auto px-4 md:px-6">
          <motion.div className="text-center max-w-2xl mx-auto mb-16" initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="text-3xl md:text-5xl font-bold mb-4" style={{ color: colors.text }}>
              <span style={{ color: colors.primary }}>変化</span>のストーリー。
            </h2>
            <p className="text-lg" style={{ color: colors.textLight }}>ほめゴハンを始める前と後で、こんなに変わりました。</p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            {[
              { name: "田中 美咲さん", avatar: "👩‍💻", age: "32歳・IT企業", before: "コンビニ弁当ばかりの毎日。健康診断の結果も悪くなる一方で、このままじゃマズいと思ってた...", after: "3ヶ月で自炊率80%に！AIに褒められるのが嬉しくて、気づいたら料理が楽しくなってました。体重も-4.2kg！", period: "3ヶ月", result: "-4.2kg" },
              { name: "佐藤 健太さん", avatar: "👨‍💼", age: "28歳・営業", before: "外食続きで体重が増える一方。何を食べていいかわからなかったし、自炊なんて無理だと思ってた。", after: "献立提案機能のおかげで迷わなくなった。週末の作り置きが習慣に。会社の健康診断も改善！", period: "2ヶ月", result: "自炊率0%→70%" },
              { name: "山田 花子さん", avatar: "👩‍🍳", age: "45歳・主婦", before: "家族の健康が心配。でも栄養計算は面倒で続かなかった。子供たちも野菜を食べてくれなくて...", after: "写真を撮るだけで家族全員の栄養管理ができるように。子供も「今日のスコア何点？」って聞いてくる！", period: "4ヶ月", result: "野菜摂取量2倍" },
            ].map((story, i) => (
              <motion.div key={i} className="p-6 rounded-3xl" style={{ background: colors.card }} initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.1 }}>
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-3xl" style={{ background: colors.bgAlt }}>{story.avatar}</div>
                  <div>
                    <p className="font-bold" style={{ color: colors.text }}>{story.name}</p>
                    <p className="text-xs" style={{ color: colors.textMuted }}>{story.age}</p>
                  </div>
                </div>

                <div className="mb-4 p-4 rounded-xl" style={{ background: '#FEF2F2' }}>
                  <p className="text-xs font-bold mb-2 flex items-center gap-1" style={{ color: '#DC2626' }}>😔 BEFORE</p>
                  <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>{story.before}</p>
                </div>

                <div className="mb-4 p-4 rounded-xl" style={{ background: colors.successLight }}>
                  <p className="text-xs font-bold mb-2 flex items-center gap-1" style={{ color: colors.success }}>🎉 AFTER</p>
                  <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>{story.after}</p>
                </div>

                <div className="flex items-center justify-between p-3 rounded-xl" style={{ background: colors.primaryLight }}>
                  <div>
                    <p className="text-xs" style={{ color: colors.textMuted }}>期間</p>
                    <p className="font-bold" style={{ color: colors.primary }}>{story.period}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs" style={{ color: colors.textMuted }}>結果</p>
                    <p className="font-bold" style={{ color: colors.primary }}>{story.result}</p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ========== FAQ ========== */}
      <section className="py-20 md:py-32">
        <div className="container mx-auto px-4 md:px-6 max-w-3xl">
          <motion.div className="text-center mb-12" initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="text-3xl md:text-5xl font-bold mb-4" style={{ color: colors.text }}>よくある質問</h2>
            <p className="text-lg" style={{ color: colors.textLight }}>気になることがあればチェック！</p>
          </motion.div>

          <div className="space-y-3">
            {faqs.map((faq, i) => (
              <motion.div key={i} className="rounded-2xl overflow-hidden" style={{ background: colors.card, border: `1px solid ${colors.border}` }} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.05 }}>
                <button onClick={() => setExpandedFaq(expandedFaq === i ? null : i)} className="w-full p-5 flex items-center justify-between text-left">
                  <span className="font-bold pr-4 flex items-center gap-2" style={{ color: colors.text }}>
                    <MessageCircle size={18} style={{ color: colors.primary }} />{faq.q}
                  </span>
                  <motion.div animate={{ rotate: expandedFaq === i ? 180 : 0 }} transition={{ duration: 0.2 }}>
                    <ChevronDown size={20} style={{ color: colors.textMuted }} />
                  </motion.div>
                </button>
                <AnimatePresence>
                  {expandedFaq === i && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3 }}>
                      <div className="px-5 pb-5">
                        <div className="p-4 rounded-xl" style={{ background: colors.bgAlt }}>
                          <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>{faq.a}</p>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </div>

          <motion.div className="text-center mt-8" initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }}>
            <p className="text-sm mb-2" style={{ color: colors.textMuted }}>他にも質問がある場合は</p>
            <Link href="/contact" className="text-sm font-bold inline-flex items-center gap-1 hover:underline" style={{ color: colors.primary }}>
              お問い合わせフォームへ <ChevronRight size={16} />
            </Link>
          </motion.div>
        </div>
      </section>

      {/* ========== 最終CTA ========== */}
      <section className="py-24 md:py-32 relative overflow-hidden" style={{ background: colors.text }}>
        <div className="absolute inset-0 opacity-5">
          <div className="absolute inset-0" style={{ backgroundImage: `radial-gradient(circle at 2px 2px, white 1px, transparent 0)`, backgroundSize: '40px 40px' }} />
        </div>

        <div className="container mx-auto px-4 md:px-6 relative z-10 text-center max-w-3xl">
          <motion.div initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <div className="text-6xl mb-6">🍽️✨</div>
            <h2 className="text-4xl md:text-5xl font-bold mb-6 text-white leading-tight">
              明日の食事が、<br />楽しみになる。
            </h2>
            <p className="text-lg md:text-xl mb-4 leading-relaxed" style={{ color: 'rgba(255,255,255,0.8)' }}>
              まずは3日間、写真を撮ってみてください。<br />
              食事が変わる感覚を、きっと実感できるはずです。
            </p>
            <p className="text-sm mb-8" style={{ color: 'rgba(255,255,255,0.5)' }}>
              10万人以上が使っている、AIダイエットパートナー。<br />
              あなたも今日から始めてみませんか？
            </p>

            <Link href="/signup">
              <motion.button className="px-10 py-5 text-lg font-bold rounded-full shadow-2xl inline-flex items-center gap-3" style={{ background: colors.primary, color: 'white' }} whileHover={{ scale: 1.05, boxShadow: `0 20px 60px ${colors.primary}60` }} whileTap={{ scale: 0.98 }}>
                <Sparkles size={24} />無料で始める<ArrowRight size={20} />
              </motion.button>
            </Link>

            <div className="flex flex-wrap justify-center gap-6 mt-8 text-sm" style={{ color: 'rgba(255,255,255,0.5)' }}>
              <span>✓ 30秒で登録完了</span>
              <span>✓ クレジットカード不要</span>
              <span>✓ いつでも退会OK</span>
            </div>

            <div className="mt-12 pt-8 border-t" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <p className="text-sm mb-4" style={{ color: 'rgba(255,255,255,0.4)' }}>こんな人におすすめ</p>
              <div className="flex flex-wrap justify-center gap-3">
                {['ダイエット中', '自炊を始めたい', '栄養バランスが気になる', '健康診断の数値が...', '料理が苦手', '忙しくて食事が乱れがち'].map((tag, i) => (
                  <span key={i} className="px-3 py-1.5 rounded-full text-xs" style={{ background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.7)' }}>{tag}</span>
                ))}
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ========== フッター ========== */}
      <footer className="py-12 md:py-16" style={{ background: colors.card, borderTop: `1px solid ${colors.border}` }}>
        <div className="container mx-auto px-4 md:px-6">
          <div className="grid md:grid-cols-4 gap-8 mb-12">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold" style={{ background: colors.primary }}>H</div>
                <span className="font-bold text-lg" style={{ color: colors.text }}>ほめゴハン</span>
              </div>
              <p className="text-sm leading-relaxed mb-4" style={{ color: colors.textLight }}>
                写真を撮るだけで、AIがあなたの食事を分析。<br />
                褒めて伸ばす、新しい食事管理アプリ。
              </p>
              <div className="flex gap-3">
                <a href="#" className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: colors.bgAlt, color: colors.textMuted }}>𝕏</a>
                <a href="#" className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: colors.bgAlt, color: colors.textMuted }}>IG</a>
                <a href="#" className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: colors.bgAlt, color: colors.textMuted }}>FB</a>
              </div>
            </div>
            
            <div>
              <h4 className="font-bold mb-4" style={{ color: colors.text }}>サービス</h4>
              <ul className="space-y-2 text-sm" style={{ color: colors.textLight }}>
                <li><Link href="/about" className="hover:underline">サービスについて</Link></li>
                <li><Link href="/signup" className="hover:underline">新規登録</Link></li>
                <li><Link href="/login" className="hover:underline">ログイン</Link></li>
                <li><Link href="/pricing" className="hover:underline">料金プラン</Link></li>
              </ul>
            </div>
            
            <div>
              <h4 className="font-bold mb-4" style={{ color: colors.text }}>サポート</h4>
              <ul className="space-y-2 text-sm" style={{ color: colors.textLight }}>
                <li><Link href="/guide" className="hover:underline">使い方ガイド</Link></li>
                <li><Link href="/contact" className="hover:underline">お問い合わせ</Link></li>
                <li><Link href="/faq" className="hover:underline">よくある質問</Link></li>
                <li><Link href="/news" className="hover:underline">お知らせ</Link></li>
              </ul>
            </div>
            
            <div>
              <h4 className="font-bold mb-4" style={{ color: colors.text }}>法的情報</h4>
              <ul className="space-y-2 text-sm" style={{ color: colors.textLight }}>
                <li><Link href="/terms" className="hover:underline">利用規約</Link></li>
                <li><Link href="/privacy" className="hover:underline">プライバシーポリシー</Link></li>
                <li><Link href="/legal" className="hover:underline">特定商取引法に基づく表記</Link></li>
                <li><Link href="/company" className="hover:underline">運営会社</Link></li>
              </ul>
            </div>
          </div>

          <div className="pt-8 border-t flex flex-col md:flex-row justify-between items-center gap-4" style={{ borderColor: colors.border }}>
            <p className="text-sm" style={{ color: colors.textMuted }}>© 2025 ほめゴハン All rights reserved.</p>
            <p className="text-xs" style={{ color: colors.textMuted }}>Made with ❤️ in Japan</p>
          </div>
        </div>
      </footer>

      {/* ========== モバイル固定CTA ========== */}
      <motion.div className="fixed bottom-0 left-0 right-0 p-4 md:hidden z-40" style={{ background: 'rgba(255,255,255,0.98)', backdropFilter: 'blur(20px)', boxShadow: '0 -4px 20px rgba(0,0,0,0.1)' }} initial={{ y: 100 }} animate={{ y: scrollY > 400 ? 0 : 100 }} transition={{ duration: 0.3 }}>
        <Link href="/signup" className="block">
          <motion.button className="w-full py-4 text-white font-bold rounded-full flex items-center justify-center gap-2" style={{ background: colors.primary }} whileTap={{ scale: 0.98 }}>
            <Sparkles size={20} />無料で始める
          </motion.button>
        </Link>
        <p className="text-center text-xs mt-2" style={{ color: colors.textMuted }}>30秒で登録完了・カード不要</p>
      </motion.div>
    </div>
  );
}
