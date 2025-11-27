"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, AnimatePresence, useScroll, useTransform, useInView } from "framer-motion";
import { 
  Camera, Sparkles, ChefHat, TrendingUp, Award, Heart, 
  Clock, Zap, Target, Users, Star, ChevronDown, ChevronRight,
  Check, X, Play, ArrowRight, Flame, Moon, Sun, Coffee,
  Scale, Activity, Trophy, Calendar, BookOpen, ShoppingCart
} from "lucide-react";

// ============================================
// カラーパレット
// ============================================
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
  bg: '#FAF9F7',
  bgAlt: '#F5F3EF',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#8A8A8A',
  border: '#E8E8E8',
};

// ============================================
// サンプルデータ
// ============================================
const sampleMeals = [
  {
    id: 1,
    image: "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400",
    name: "彩り野菜のサラダボウル",
    score: 95,
    comment: "彩りが素晴らしい！アボカドの良質な脂質と、野菜のビタミンがしっかり摂れていますね。",
    nutrients: { cal: 380, protein: 12, veg: 95 }
  },
  {
    id: 2,
    image: "https://images.unsplash.com/photo-1547592180-85f173990554?w=400",
    name: "和風定食",
    score: 92,
    comment: "バランス最高！焼き魚のDHAと、味噌汁の発酵パワーで腸活もバッチリです。",
    nutrients: { cal: 520, protein: 28, veg: 80 }
  },
  {
    id: 3,
    image: "https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=400",
    name: "トマトパスタ",
    score: 88,
    comment: "トマトのリコピンたっぷり！オリーブオイルとの相性で吸収率もアップしています。",
    nutrients: { cal: 620, protein: 18, veg: 70 }
  }
];

const userStories = [
  {
    name: "田中 美咲",
    age: "32歳",
    job: "IT企業勤務",
    avatar: "👩‍💻",
    before: "コンビニ弁当ばかりの毎日。健康診断の結果も悪くなる一方...",
    after: "3ヶ月で自炊率80%に！AIに褒められるのが嬉しくて、気づいたら料理が楽しくなってました。",
    result: "-4.2kg",
    period: "3ヶ月"
  },
  {
    name: "佐藤 健太",
    age: "28歳",
    job: "営業職",
    avatar: "👨‍💼",
    before: "外食続きで体重が増える一方。何を食べていいかわからなかった。",
    after: "献立提案機能のおかげで迷わなくなった。週末の作り置きが習慣に。",
    result: "自炊率 0%→70%",
    period: "2ヶ月"
  },
  {
    name: "山田 花子",
    age: "45歳",
    job: "主婦",
    avatar: "👩‍🍳",
    before: "家族の健康が心配。でも栄養計算は面倒で続かなかった。",
    after: "写真を撮るだけで家族全員の栄養管理ができるように。子供も野菜を食べるようになりました！",
    result: "家族全員 野菜摂取量2倍",
    period: "4ヶ月"
  }
];

const badges = [
  { icon: "🌅", name: "朝食マスター", desc: "朝食を7日連続記録", color: colors.warning },
  { icon: "🔥", name: "7日連続", desc: "1週間毎日記録達成", color: colors.primary },
  { icon: "🥗", name: "野菜マニア", desc: "野菜スコア90以上を10回", color: colors.success },
  { icon: "👨‍🍳", name: "自炊デビュー", desc: "初めての自炊記録", color: colors.secondary },
  { icon: "🌙", name: "夜更かし撃退", desc: "夜食を3日連続回避", color: '#7C4DFF' },
  { icon: "💪", name: "タンパク質キング", desc: "タンパク質目標を7日達成", color: colors.primary },
  { icon: "🎯", name: "目標達成", desc: "設定した目標を達成", color: colors.success },
  { icon: "👑", name: "マスターシェフ", desc: "30日連続自炊達成", color: '#FFD700' },
];

const faqs = [
  {
    q: "本当に無料で使えますか？",
    a: "はい、基本機能は完全無料です。写真撮影、AI分析、献立提案、健康記録などすべてお使いいただけます。将来的にプレミアム機能を追加予定ですが、現在の機能は永久無料でご利用いただけます。"
  },
  {
    q: "どんな写真を撮ればいいですか？",
    a: "食事全体が写っていれば大丈夫です。真上からでも斜めからでもOK。AIが自動で食材を認識し、栄養素を推定します。暗い写真や一部が隠れている場合は精度が下がることがあります。"
  },
  {
    q: "データは安全ですか？",
    a: "はい、すべてのデータは暗号化して保存されます。写真や健康データは厳重に管理され、第三者に共有されることはありません。いつでもデータの削除をリクエストできます。"
  },
  {
    q: "家族で使えますか？",
    a: "現在は個人アカウントのみですが、家族プラン機能を開発中です。お子様や高齢のご家族の食事管理にも使いやすい機能を準備しています。"
  },
  {
    q: "オフラインでも使えますか？",
    a: "写真の撮影と保存はオフラインでも可能です。AI分析や献立提案にはインターネット接続が必要ですが、接続時に自動で同期されます。"
  }
];

// ============================================
// カウントアップフック
// ============================================
const useCountUp = (end: number, duration: number = 2000, startOnView: boolean = true) => {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true });
  const hasStarted = useRef(false);

  useEffect(() => {
    if (startOnView && !isInView) return;
    if (hasStarted.current) return;
    hasStarted.current = true;

    let startTime: number;
    const animate = (currentTime: number) => {
      if (!startTime) startTime = currentTime;
      const progress = Math.min((currentTime - startTime) / duration, 1);
      setCount(Math.floor(progress * end));
      if (progress < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }, [end, duration, isInView, startOnView]);

  return { count, ref };
};

// ============================================
// メインコンポーネント
// ============================================
export default function LandingPage() {
  const [selectedMeal, setSelectedMeal] = useState<number | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisComplete, setAnalysisComplete] = useState(false);
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);
  const [hoveredBadge, setHoveredBadge] = useState<number | null>(null);
  const [scrollY, setScrollY] = useState(0);

  const heroRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll();
  const heroOpacity = useTransform(scrollYProgress, [0, 0.15], [1, 0]);
  const heroScale = useTransform(scrollYProgress, [0, 0.15], [1, 0.95]);

  // カウントアップ
  const mealsCount = useCountUp(1234567, 2500);
  const retentionCount = useCountUp(98, 2000);
  const streakCount = useCountUp(42, 1500);

  useEffect(() => {
    const handleScroll = () => setScrollY(window.scrollY);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // デモ分析
  const handleMealSelect = (id: number) => {
    setSelectedMeal(id);
    setIsAnalyzing(true);
    setAnalysisComplete(false);
    
    setTimeout(() => {
      setIsAnalyzing(false);
      setAnalysisComplete(true);
    }, 2000);
  };

  const selectedMealData = sampleMeals.find(m => m.id === selectedMeal);

  return (
    <div className="relative w-full min-h-screen overflow-x-hidden" style={{ background: colors.bg }}>
      
      {/* ============================================ */}
      {/* 背景エフェクト */}
      {/* ============================================ */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <motion.div 
          className="absolute w-[800px] h-[800px] rounded-full blur-3xl"
          style={{ 
            background: `radial-gradient(circle, ${colors.primaryLight} 0%, transparent 70%)`,
            top: '-20%',
            left: '-10%',
          }}
          animate={{ 
            x: [0, 50, 0],
            y: [0, 30, 0],
          }}
          transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div 
          className="absolute w-[600px] h-[600px] rounded-full blur-3xl"
          style={{ 
            background: `radial-gradient(circle, ${colors.secondaryLight} 0%, transparent 70%)`,
            top: '40%',
            right: '-15%',
          }}
          animate={{ 
            x: [0, -30, 0],
            y: [0, 50, 0],
          }}
          transition={{ duration: 15, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      {/* ============================================ */}
      {/* ヘッダー */}
      {/* ============================================ */}
      <header 
        className="fixed top-0 w-full z-50 transition-all duration-300"
        style={{ 
          background: scrollY > 50 ? 'rgba(255,255,255,0.95)' : 'transparent',
          backdropFilter: scrollY > 50 ? 'blur(20px)' : 'none',
          borderBottom: scrollY > 50 ? `1px solid ${colors.border}` : 'none',
        }}
      >
        <div className="container mx-auto px-6 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 group">
            <motion.div 
              className="w-11 h-11 rounded-xl flex items-center justify-center text-white font-bold text-lg shadow-lg"
              style={{ background: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.primaryDark} 100%)` }}
              whileHover={{ scale: 1.05, rotate: 5 }}
            >
              H
            </motion.div>
            <span className="font-bold text-xl tracking-tight" style={{ color: colors.text }}>
              ほめゴハン
            </span>
          </Link>
          
          <div className="flex items-center gap-4">
            <Link 
              href="/login" 
              className="hidden sm:block text-sm font-medium px-4 py-2 rounded-full transition-all hover:bg-gray-100"
              style={{ color: colors.textLight }}
            >
              ログイン
            </Link>
            <Link href="/signup">
              <motion.button
                className="text-sm font-bold px-6 py-3 text-white rounded-full shadow-lg"
                style={{ background: colors.text }}
                whileHover={{ scale: 1.05, boxShadow: '0 10px 30px rgba(0,0,0,0.2)' }}
                whileTap={{ scale: 0.98 }}
              >
                無料で始める
              </motion.button>
            </Link>
          </div>
        </div>
      </header>

      {/* ============================================ */}
      {/* Section 1: ヒーロー（没入型） */}
      {/* ============================================ */}
      <motion.section 
        ref={heroRef}
        className="relative min-h-screen flex items-center pt-20"
        style={{ opacity: heroOpacity, scale: heroScale }}
      >
        <div className="container mx-auto px-6 py-20">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            
            {/* テキストエリア */}
            <motion.div 
              className="space-y-8"
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8 }}
            >
              {/* バッジ */}
              <motion.div 
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold tracking-wide"
                style={{ background: colors.primaryLight, color: colors.primary }}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 }}
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: colors.primary }} />
                  <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: colors.primary }} />
                </span>
                AI DIETARY PARTNER
              </motion.div>

              {/* メインコピー */}
              <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold leading-[1.08] tracking-tight" style={{ color: colors.text }}>
                食べることを、
                <br />
                <span 
                  className="text-transparent bg-clip-text"
                  style={{ backgroundImage: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.warning} 100%)` }}
                >
                  もっと誇らしく。
                </span>
              </h1>

              {/* サブコピー */}
              <p className="text-lg md:text-xl leading-relaxed max-w-lg" style={{ color: colors.textLight }}>
                写真を撮るだけで、AIがあなたの食事を分析。
                <br />
                ダメ出しじゃなく、<strong style={{ color: colors.primary }}>良いところを見つけて褒める</strong>。
                <br />
                だから、続けられる。
              </p>

              {/* CTA */}
              <div className="flex flex-col sm:flex-row gap-4 pt-4">
                <Link href="/signup">
                  <motion.button
                    className="w-full sm:w-auto px-8 py-4 text-white font-bold rounded-full shadow-xl flex items-center justify-center gap-2"
                    style={{ background: colors.primary }}
                    whileHover={{ scale: 1.03, boxShadow: `0 20px 40px ${colors.primary}40` }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <Sparkles size={20} />
                    無料で試してみる
                  </motion.button>
                </Link>
                <motion.button
                  onClick={() => document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth' })}
                  className="w-full sm:w-auto px-8 py-4 font-bold rounded-full flex items-center justify-center gap-2"
                  style={{ background: colors.card, color: colors.textLight, border: `2px solid ${colors.border}` }}
                  whileHover={{ scale: 1.03, borderColor: colors.primary }}
                  whileTap={{ scale: 0.98 }}
                >
                  <Play size={18} />
                  デモを体験
                </motion.button>
              </div>

              {/* 信頼指標 */}
              <div className="flex flex-wrap items-center gap-6 pt-4 text-sm" style={{ color: colors.textMuted }}>
                <div className="flex items-center gap-2">
                  <Check size={18} style={{ color: colors.success }} />
                  30秒で登録完了
                </div>
                <div className="flex items-center gap-2">
                  <Check size={18} style={{ color: colors.success }} />
                  クレジットカード不要
                </div>
                <div className="flex items-center gap-2">
                  <Check size={18} style={{ color: colors.success }} />
                  いつでも解約OK
                </div>
              </div>
            </motion.div>

            {/* ビジュアルエリア: インタラクティブデモ */}
            <motion.div 
              id="demo"
              className="relative"
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.2 }}
            >
              <div className="relative z-10 mx-auto max-w-[400px]">
                {/* デモカード */}
                <div 
                  className="rounded-3xl p-6 shadow-2xl"
                  style={{ background: colors.card }}
                >
                  <div className="text-center mb-6">
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold mb-3" style={{ background: colors.primaryLight, color: colors.primary }}>
                      <Sparkles size={14} />
                      AIデモ体験
                    </div>
                    <h3 className="text-lg font-bold" style={{ color: colors.text }}>
                      写真を選んで分析してみよう
                    </h3>
                  </div>

                  {/* 食事選択 */}
                  <div className="grid grid-cols-3 gap-3 mb-6">
                    {sampleMeals.map((meal) => (
                      <motion.button
                        key={meal.id}
                        onClick={() => handleMealSelect(meal.id)}
                        className="relative aspect-square rounded-xl overflow-hidden"
                        style={{ 
                          border: selectedMeal === meal.id ? `3px solid ${colors.primary}` : `2px solid ${colors.border}`,
                        }}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                      >
                        <Image src={meal.image} alt={meal.name} fill className="object-cover" unoptimized />
                        {selectedMeal === meal.id && (
                          <div className="absolute inset-0 flex items-center justify-center" style={{ background: `${colors.primary}40` }}>
                            <Check size={24} color="white" />
                          </div>
                        )}
                      </motion.button>
                    ))}
                  </div>

                  {/* 分析結果 */}
                  <AnimatePresence mode="wait">
                    {isAnalyzing && (
                      <motion.div
                        key="analyzing"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="p-6 rounded-2xl text-center"
                        style={{ background: colors.bgAlt }}
                      >
                        <div className="w-12 h-12 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ background: colors.primary }}>
                          <motion.div
                            animate={{ rotate: 360 }}
                            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                          >
                            <Sparkles size={24} color="white" />
                          </motion.div>
                        </div>
                        <p className="font-bold mb-2" style={{ color: colors.text }}>AIが分析中...</p>
                        <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: colors.border }}>
                          <motion.div
                            className="h-full rounded-full"
                            style={{ background: colors.primary }}
                            initial={{ width: 0 }}
                            animate={{ width: '100%' }}
                            transition={{ duration: 2 }}
                          />
                        </div>
                      </motion.div>
                    )}

                    {analysisComplete && selectedMealData && (
                      <motion.div
                        key="result"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="p-5 rounded-2xl"
                        style={{ background: colors.successLight }}
                      >
                        <div className="flex items-start gap-3 mb-4">
                          <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: colors.primary }}>
                            <Sparkles size={20} color="white" />
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-bold" style={{ color: colors.text }}>AI分析完了！</span>
                              <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ background: colors.success, color: 'white' }}>
                                スコア {selectedMealData.score}
                              </span>
                            </div>
                            <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>
                              {selectedMealData.comment}
                            </p>
                          </div>
                        </div>
                        
                        <div className="grid grid-cols-3 gap-2">
                          <div className="p-3 rounded-xl text-center" style={{ background: colors.card }}>
                            <p className="text-xs mb-1" style={{ color: colors.textMuted }}>カロリー</p>
                            <p className="font-bold" style={{ color: colors.text }}>{selectedMealData.nutrients.cal}</p>
                          </div>
                          <div className="p-3 rounded-xl text-center" style={{ background: colors.card }}>
                            <p className="text-xs mb-1" style={{ color: colors.textMuted }}>タンパク質</p>
                            <p className="font-bold" style={{ color: colors.text }}>{selectedMealData.nutrients.protein}g</p>
                          </div>
                          <div className="p-3 rounded-xl text-center" style={{ background: colors.card }}>
                            <p className="text-xs mb-1" style={{ color: colors.textMuted }}>野菜スコア</p>
                            <p className="font-bold" style={{ color: colors.success }}>{selectedMealData.nutrients.veg}</p>
                          </div>
                        </div>
                      </motion.div>
                    )}

                    {!isAnalyzing && !analysisComplete && (
                      <motion.div
                        key="placeholder"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="p-6 rounded-2xl text-center"
                        style={{ background: colors.bgAlt, border: `2px dashed ${colors.border}` }}
                      >
                        <Camera size={32} className="mx-auto mb-3" style={{ color: colors.textMuted }} />
                        <p className="text-sm" style={{ color: colors.textMuted }}>
                          上の写真をタップして
                          <br />
                          AI分析を体験してみよう
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* フローティング装飾 */}
                <motion.div
                  className="absolute -top-4 -right-4 p-3 rounded-2xl shadow-xl"
                  style={{ background: colors.card }}
                  animate={{ y: [0, -10, 0] }}
                  transition={{ duration: 3, repeat: Infinity }}
                >
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: colors.successLight }}>
                      <Check size={16} style={{ color: colors.success }} />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold" style={{ color: colors.textMuted }}>ビタミンC</p>
                      <p className="text-xs font-bold" style={{ color: colors.success }}>Perfect!</p>
                    </div>
                  </div>
                </motion.div>

                <motion.div
                  className="absolute -bottom-4 -left-4 p-3 rounded-2xl shadow-xl"
                  style={{ background: colors.card }}
                  animate={{ y: [0, 10, 0] }}
                  transition={{ duration: 4, repeat: Infinity }}
                >
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: colors.primaryLight }}>
                      <Flame size={16} style={{ color: colors.primary }} />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold" style={{ color: colors.textMuted }}>連続記録</p>
                      <p className="text-xs font-bold" style={{ color: colors.primary }}>7日目!</p>
                    </div>
                  </div>
                </motion.div>
              </div>

              {/* 背景グロー */}
              <div 
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full blur-3xl -z-10"
                style={{ background: `${colors.primary}15` }}
              />
            </motion.div>
          </div>
        </div>

        {/* スクロールインジケーター */}
        <motion.div 
          className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
          animate={{ y: [0, 10, 0] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          <span className="text-xs font-medium" style={{ color: colors.textMuted }}>スクロールして続きを見る</span>
          <ChevronDown size={20} style={{ color: colors.textMuted }} />
        </motion.div>
      </motion.section>

      {/* ============================================ */}
      {/* Section 2: 数字で語る */}
      {/* ============================================ */}
      <section className="py-20 relative overflow-hidden" style={{ background: colors.card }}>
        <div className="container mx-auto px-6">
          <div className="grid md:grid-cols-3 gap-8">
            {[
              { 
                icon: <Camera size={28} />, 
                countRef: mealsCount.ref, 
                count: mealsCount.count.toLocaleString(), 
                suffix: '+',
                label: '食の分析実績',
                color: colors.primary 
              },
              { 
                icon: <Heart size={28} />, 
                countRef: retentionCount.ref, 
                count: retentionCount.count, 
                suffix: '%',
                label: 'のユーザーが継続',
                color: colors.success 
              },
              { 
                icon: <Flame size={28} />, 
                countRef: streakCount.ref, 
                count: streakCount.count, 
                suffix: '日',
                label: '最長連続記録',
                color: colors.warning 
              },
            ].map((item, i) => (
              <motion.div
                key={i}
                ref={item.countRef}
                className="text-center p-8 rounded-3xl"
                style={{ background: colors.bgAlt }}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
              >
                <div 
                  className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center"
                  style={{ background: `${item.color}20`, color: item.color }}
                >
                  {item.icon}
                </div>
                <div className="text-4xl md:text-5xl font-bold mb-2" style={{ color: item.color }}>
                  {item.count}{item.suffix}
                </div>
                <p className="font-medium" style={{ color: colors.textLight }}>{item.label}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ============================================ */}
      {/* Section 3: 3ステップで始める */}
      {/* ============================================ */}
      <section className="py-32 relative">
        <div className="container mx-auto px-6">
          <motion.div 
            className="text-center max-w-2xl mx-auto mb-20"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-5xl font-bold mb-6" style={{ color: colors.text }}>
              たった3ステップで、
              <br />
              <span style={{ color: colors.primary }}>食生活が変わる。</span>
            </h2>
            <p className="text-lg" style={{ color: colors.textLight }}>
              難しい設定は一切なし。今日から始められます。
            </p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-8 relative">
            {/* 接続線 */}
            <div className="hidden md:block absolute top-24 left-1/4 right-1/4 h-0.5" style={{ background: colors.border }} />
            
            {[
              { 
                step: 1, 
                icon: <Camera size={32} />, 
                title: '撮る', 
                desc: '食事の写真を撮るだけ。カロリー入力も食材選択も不要。1秒で完了します。',
                color: colors.primary
              },
              { 
                step: 2, 
                icon: <Sparkles size={32} />, 
                title: 'AIが分析', 
                desc: '最新のAIが食材を認識し、栄養バランスを瞬時に解析。良い点を見つけます。',
                color: colors.secondary
              },
              { 
                step: 3, 
                icon: <Heart size={32} />, 
                title: '褒められる', 
                desc: '「彩りが素晴らしい！」ポジティブなフィードバックで、明日も続けたくなる。',
                color: colors.success
              },
            ].map((item, i) => (
              <motion.div
                key={i}
                className="relative text-center"
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.15 }}
              >
                <div className="relative z-10 mb-6">
                  <div 
                    className="w-20 h-20 mx-auto rounded-3xl flex items-center justify-center shadow-lg"
                    style={{ background: colors.card, color: item.color }}
                  >
                    {item.icon}
                  </div>
                  <div 
                    className="absolute -top-2 -right-2 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white"
                    style={{ background: item.color }}
                  >
                    {item.step}
                  </div>
                </div>
                <h3 className="text-2xl font-bold mb-3" style={{ color: colors.text }}>{item.title}</h3>
                <p className="leading-relaxed" style={{ color: colors.textLight }}>{item.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ============================================ */}
      {/* Section 4: 一日の流れ */}
      {/* ============================================ */}
      <section className="py-32 relative overflow-hidden" style={{ background: colors.bgAlt }}>
        <div className="container mx-auto px-6">
          <motion.div 
            className="text-center max-w-2xl mx-auto mb-20"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-5xl font-bold mb-6" style={{ color: colors.text }}>
              AIと過ごす、
              <br />
              <span style={{ color: colors.primary }}>1日の食事。</span>
            </h2>
          </motion.div>

          <div className="max-w-3xl mx-auto">
            {[
              { 
                time: '7:00', 
                icon: <Sun size={24} />, 
                title: '朝食',
                meal: 'トーストと目玉焼き',
                image: 'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=300',
                comment: 'おはようございます！卵のタンパク質が午前中の集中力をサポートします 💪',
                color: colors.warning
              },
              { 
                time: '12:30', 
                icon: <Coffee size={24} />, 
                title: '昼食',
                meal: 'チキンサラダ',
                image: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=300',
                comment: '野菜たっぷりで素晴らしい！午後も元気に過ごせそうですね 🥗',
                color: colors.success
              },
              { 
                time: '19:00', 
                icon: <Moon size={24} />, 
                title: '夕食',
                meal: '鮭の塩焼き定食',
                image: 'https://images.unsplash.com/photo-1580822184713-fc5400e7fe10?w=300',
                comment: '今日の食事、トータルでとてもバランスが良いです！明日も一緒に頑張りましょう ✨',
                color: colors.secondary
              },
            ].map((item, i) => (
              <motion.div
                key={i}
                className="flex gap-6 mb-12 last:mb-0"
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.2 }}
              >
                {/* タイムライン */}
                <div className="flex flex-col items-center">
                  <div 
                    className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0"
                    style={{ background: `${item.color}20`, color: item.color }}
                  >
                    {item.icon}
                  </div>
                  {i < 2 && (
                    <div className="w-0.5 flex-1 my-2" style={{ background: colors.border }} />
                  )}
                </div>

                {/* コンテンツ */}
                <div className="flex-1 pb-8">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-2xl font-bold" style={{ color: item.color }}>{item.time}</span>
                    <span className="font-medium" style={{ color: colors.text }}>{item.title}</span>
                  </div>
                  
                  <div className="p-4 rounded-2xl" style={{ background: colors.card }}>
                    <div className="flex gap-4">
                      <div className="w-20 h-20 rounded-xl overflow-hidden flex-shrink-0">
                        <Image src={item.image} alt={item.meal} width={80} height={80} className="object-cover w-full h-full" unoptimized />
                      </div>
                      <div className="flex-1">
                        <p className="font-bold mb-2" style={{ color: colors.text }}>{item.meal}</p>
                        <div className="flex items-start gap-2">
                          <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: colors.primary }}>
                            <Sparkles size={12} color="white" />
                          </div>
                          <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>
                            {item.comment}
                          </p>
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

      {/* ============================================ */}
      {/* Section 5: 機能ハイライト */}
      {/* ============================================ */}
      <section className="py-32">
        <div className="container mx-auto px-6">
          <motion.div 
            className="text-center max-w-2xl mx-auto mb-20"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-5xl font-bold mb-6" style={{ color: colors.text }}>
              すべてが揃った、
              <br />
              <span style={{ color: colors.primary }}>オールインワン。</span>
            </h2>
          </motion.div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { 
                icon: <Camera size={28} />, 
                title: '写真で記録', 
                desc: '撮るだけでAIが栄養を自動計算',
                color: colors.primary
              },
              { 
                icon: <ChefHat size={28} />, 
                title: 'AI献立提案', 
                desc: '1週間分の献立を自動生成',
                color: colors.success
              },
              { 
                icon: <Scale size={28} />, 
                title: '健康記録', 
                desc: '体重・睡眠・気分をトラッキング',
                color: colors.secondary
              },
              { 
                icon: <Trophy size={28} />, 
                title: 'バッジ収集', 
                desc: '達成感でモチベーション維持',
                color: colors.warning
              },
              { 
                icon: <ShoppingCart size={28} />, 
                title: '買い物リスト', 
                desc: '献立から自動で買い物リスト作成',
                color: '#7C4DFF'
              },
              { 
                icon: <TrendingUp size={28} />, 
                title: '週次レポート', 
                desc: 'AIが食生活を分析してアドバイス',
                color: colors.primary
              },
              { 
                icon: <BookOpen size={28} />, 
                title: 'レシピ提案', 
                desc: '冷蔵庫の食材から最適なレシピを',
                color: colors.success
              },
              { 
                icon: <Target size={28} />, 
                title: '目標設定', 
                desc: '減量・筋トレなど目的に合わせて',
                color: colors.secondary
              },
            ].map((item, i) => (
              <motion.div
                key={i}
                className="p-6 rounded-2xl transition-all cursor-pointer group"
                style={{ background: colors.card, border: `1px solid ${colors.border}` }}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05 }}
                whileHover={{ y: -5, boxShadow: '0 20px 40px rgba(0,0,0,0.1)' }}
              >
                <div 
                  className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4 transition-transform group-hover:scale-110"
                  style={{ background: `${item.color}15`, color: item.color }}
                >
                  {item.icon}
                </div>
                <h3 className="font-bold mb-2" style={{ color: colors.text }}>{item.title}</h3>
                <p className="text-sm" style={{ color: colors.textLight }}>{item.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ============================================ */}
      {/* Section 6: バッジコレクション */}
      {/* ============================================ */}
      <section className="py-32" style={{ background: colors.bgAlt }}>
        <div className="container mx-auto px-6">
          <motion.div 
            className="text-center max-w-2xl mx-auto mb-16"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-5xl font-bold mb-6" style={{ color: colors.text }}>
              🏆 集めよう、
              <br />
              <span style={{ color: colors.primary }}>あなたの勲章。</span>
            </h2>
            <p className="text-lg" style={{ color: colors.textLight }}>
              目標を達成するたびにバッジをゲット。
              <br />
              コレクションが増えるほど、自信がつく。
            </p>
          </motion.div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mx-auto">
            {badges.map((badge, i) => (
              <motion.div
                key={i}
                className="relative p-6 rounded-2xl text-center cursor-pointer"
                style={{ background: colors.card }}
                initial={{ opacity: 0, scale: 0.8 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05 }}
                whileHover={{ scale: 1.05, boxShadow: `0 10px 30px ${badge.color}30` }}
                onHoverStart={() => setHoveredBadge(i)}
                onHoverEnd={() => setHoveredBadge(null)}
              >
                <div className="text-4xl mb-3">{badge.icon}</div>
                <p className="font-bold text-sm mb-1" style={{ color: colors.text }}>{badge.name}</p>
                
                <AnimatePresence>
                  {hoveredBadge === i && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute inset-x-2 -bottom-2 translate-y-full p-3 rounded-xl text-xs z-10"
                      style={{ background: colors.text, color: 'white' }}
                    >
                      {badge.desc}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ============================================ */}
      {/* Section 7: ユーザーストーリー */}
      {/* ============================================ */}
      <section className="py-32">
        <div className="container mx-auto px-6">
          <motion.div 
            className="text-center max-w-2xl mx-auto mb-20"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-5xl font-bold mb-6" style={{ color: colors.text }}>
              みんなの
              <br />
              <span style={{ color: colors.primary }}>変化のストーリー。</span>
            </h2>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-8">
            {userStories.map((story, i) => (
              <motion.div
                key={i}
                className="p-8 rounded-3xl"
                style={{ background: colors.card, border: `1px solid ${colors.border}` }}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
              >
                {/* プロフィール */}
                <div className="flex items-center gap-4 mb-6">
                  <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl" style={{ background: colors.bgAlt }}>
                    {story.avatar}
                  </div>
                  <div>
                    <p className="font-bold" style={{ color: colors.text }}>{story.name}</p>
                    <p className="text-sm" style={{ color: colors.textMuted }}>{story.age} / {story.job}</p>
                  </div>
                </div>

                {/* Before */}
                <div className="mb-4 p-4 rounded-xl" style={{ background: colors.bgAlt }}>
                  <p className="text-xs font-bold mb-2" style={{ color: colors.textMuted }}>BEFORE</p>
                  <p className="text-sm" style={{ color: colors.textLight }}>{story.before}</p>
                </div>

                {/* After */}
                <div className="mb-6 p-4 rounded-xl" style={{ background: colors.successLight }}>
                  <p className="text-xs font-bold mb-2" style={{ color: colors.success }}>AFTER</p>
                  <p className="text-sm" style={{ color: colors.textLight }}>{story.after}</p>
                </div>

                {/* 結果 */}
                <div className="flex items-center justify-between p-4 rounded-xl" style={{ background: colors.primaryLight }}>
                  <div>
                    <p className="text-xs" style={{ color: colors.textMuted }}>結果</p>
                    <p className="font-bold" style={{ color: colors.primary }}>{story.result}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs" style={{ color: colors.textMuted }}>期間</p>
                    <p className="font-bold" style={{ color: colors.primary }}>{story.period}</p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ============================================ */}
      {/* Section 8: FAQ */}
      {/* ============================================ */}
      <section className="py-32" style={{ background: colors.bgAlt }}>
        <div className="container mx-auto px-6 max-w-3xl">
          <motion.div 
            className="text-center mb-16"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-5xl font-bold mb-6" style={{ color: colors.text }}>
              よくある質問
            </h2>
          </motion.div>

          <div className="space-y-4">
            {faqs.map((faq, i) => (
              <motion.div
                key={i}
                className="rounded-2xl overflow-hidden"
                style={{ background: colors.card }}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05 }}
              >
                <button
                  onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
                  className="w-full p-6 flex items-center justify-between text-left"
                >
                  <span className="font-bold pr-4" style={{ color: colors.text }}>{faq.q}</span>
                  <motion.div
                    animate={{ rotate: expandedFaq === i ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <ChevronDown size={20} style={{ color: colors.textMuted }} />
                  </motion.div>
                </button>
                
                <AnimatePresence>
                  {expandedFaq === i && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3 }}
                    >
                      <div className="px-6 pb-6">
                        <p className="leading-relaxed" style={{ color: colors.textLight }}>{faq.a}</p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ============================================ */}
      {/* Section 9: 最終CTA */}
      {/* ============================================ */}
      <section className="py-32 relative overflow-hidden" style={{ background: colors.text }}>
        {/* 背景パターン */}
        <div className="absolute inset-0 opacity-5">
          <div className="absolute inset-0" style={{ 
            backgroundImage: `radial-gradient(circle at 2px 2px, white 1px, transparent 0)`,
            backgroundSize: '40px 40px'
          }} />
        </div>

        <div className="container mx-auto px-6 relative z-10 text-center max-w-3xl">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <div className="text-6xl mb-8">🍽️</div>
            
            <h2 className="text-4xl md:text-5xl font-bold mb-8 text-white leading-tight">
              明日の食事が、
              <br />
              楽しみになる。
            </h2>
            
            <p className="text-xl mb-12 leading-relaxed" style={{ color: 'rgba(255,255,255,0.7)' }}>
              まずは3日間、写真を撮ってみてください。
              <br />
              食事が変わる感覚を、きっと実感できるはずです。
            </p>

            <Link href="/signup">
              <motion.button
                className="px-12 py-5 text-lg font-bold rounded-full shadow-2xl inline-flex items-center gap-3"
                style={{ background: colors.primary, color: 'white' }}
                whileHover={{ scale: 1.05, boxShadow: `0 20px 60px ${colors.primary}60` }}
                whileTap={{ scale: 0.98 }}
              >
                <Sparkles size={24} />
                無料で始める
                <ArrowRight size={20} />
              </motion.button>
            </Link>

            <div className="flex justify-center gap-8 mt-8 text-sm" style={{ color: 'rgba(255,255,255,0.5)' }}>
              <span>✓ 30秒で登録</span>
              <span>✓ カード不要</span>
              <span>✓ いつでも解約OK</span>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ============================================ */}
      {/* フッター */}
      {/* ============================================ */}
      <footer className="py-16" style={{ background: colors.card, borderTop: `1px solid ${colors.border}` }}>
        <div className="container mx-auto px-6">
          <div className="flex flex-col md:flex-row justify-between items-center gap-8">
            <div className="flex items-center gap-3">
              <div 
                className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold"
                style={{ background: colors.primary }}
              >
                H
              </div>
              <span className="font-bold text-lg" style={{ color: colors.text }}>ほめゴハン</span>
            </div>
            
            <div className="flex flex-wrap justify-center gap-8 text-sm" style={{ color: colors.textLight }}>
              <Link href="/about" className="hover:text-primary transition-colors">サービスについて</Link>
              <Link href="/terms" className="hover:text-primary transition-colors">利用規約</Link>
              <Link href="/privacy" className="hover:text-primary transition-colors">プライバシーポリシー</Link>
              <Link href="/contact" className="hover:text-primary transition-colors">お問い合わせ</Link>
            </div>
            
            <p className="text-sm" style={{ color: colors.textMuted }}>
              © 2025 ほめゴハン
            </p>
          </div>
        </div>
      </footer>

      {/* ============================================ */}
      {/* モバイル固定CTA */}
      {/* ============================================ */}
      <motion.div 
        className="fixed bottom-0 left-0 right-0 p-4 md:hidden z-40"
        style={{ background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(20px)', borderTop: `1px solid ${colors.border}` }}
        initial={{ y: 100 }}
        animate={{ y: scrollY > 500 ? 0 : 100 }}
        transition={{ duration: 0.3 }}
      >
        <Link href="/signup" className="block">
          <motion.button
            className="w-full py-4 text-white font-bold rounded-full flex items-center justify-center gap-2"
            style={{ background: colors.primary }}
            whileTap={{ scale: 0.98 }}
          >
            <Sparkles size={20} />
            無料で始める
          </motion.button>
        </Link>
      </motion.div>
    </div>
  );
}
