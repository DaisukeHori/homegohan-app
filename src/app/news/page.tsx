"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Calendar, Tag, ChevronRight, Bell, Megaphone, Sparkles, Wrench } from "lucide-react";

const colors = {
  primary: '#E07A5F',
  primaryLight: '#FDF0ED',
  secondary: '#3D5A80',
  secondaryLight: '#E8EEF4',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#F4A261',
  warningLight: '#FEF6EE',
  bg: '#FAF9F7',
  bgAlt: '#F5F3EF',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#8A8A8A',
  border: '#E8E8E8',
};

const categories = [
  { id: 'all', name: 'すべて', icon: <Bell size={16} /> },
  { id: 'update', name: 'アップデート', icon: <Sparkles size={16} /> },
  { id: 'notice', name: 'お知らせ', icon: <Megaphone size={16} /> },
  { id: 'maintenance', name: 'メンテナンス', icon: <Wrench size={16} /> },
];

const news = [
  {
    id: 1,
    category: 'update',
    title: '【新機能】健康記録機能をリリースしました',
    date: '2025-01-20',
    summary: '体重、睡眠、気分などを記録できる健康記録機能を追加しました。写真で体重計を撮影すると自動で数値を認識します。',
    content: `
いつもほめゴハンをご利用いただきありがとうございます。

本日、健康記録機能をリリースしました！

【新機能の概要】
・体重、体脂肪率、血圧などの記録
・睡眠時間、睡眠の質の記録
・気分・コンディションの記録
・体重計の写真から自動で数値を認識
・週間・月間のトレンドグラフ
・AIによる健康アドバイス

【使い方】
1. ホーム画面の「健康」タブをタップ
2. 記録したい項目を選択
3. 数値を入力または写真を撮影

ぜひお試しください！
    `,
    isNew: true,
  },
  {
    id: 2,
    category: 'update',
    title: '【改善】AI分析の精度が向上しました',
    date: '2025-01-15',
    summary: '最新のAIモデルを導入し、食事の認識精度が大幅に向上しました。特に和食の認識が改善されています。',
    content: `
AIモデルをアップデートし、食事の認識精度を向上させました。

【改善点】
・和食の認識精度が約20%向上
・複数の料理が写っている場合の認識改善
・暗い場所で撮影した写真の認識改善
・調理方法（焼き、煮、揚げなど）の認識追加

引き続き精度向上に努めてまいります。
    `,
    isNew: true,
  },
  {
    id: 3,
    category: 'notice',
    title: '【お知らせ】メディア掲載のお知らせ',
    date: '2025-01-10',
    summary: '日経新聞、東洋経済、Forbesなど各メディアでほめゴハンが紹介されました。',
    content: `
ほめゴハンが以下のメディアで紹介されました。

・日経新聞「AI活用の食事管理アプリが人気」
・東洋経済「褒めて伸ばす新しい健康管理」
・Forbes Japan「注目のヘルステックスタートアップ」
・TechCrunch「AIが食事を褒める新サービス」

今後もユーザーの皆様に愛されるサービスを目指してまいります。
    `,
    isNew: false,
  },
  {
    id: 4,
    category: 'maintenance',
    title: '【完了】システムメンテナンスのお知らせ',
    date: '2025-01-05',
    summary: '1月5日 2:00〜5:00のメンテナンスは予定通り完了しました。',
    content: `
1月5日 2:00〜5:00に実施したシステムメンテナンスは予定通り完了しました。

【メンテナンス内容】
・サーバーの増強
・データベースの最適化
・セキュリティアップデート

ご不便をおかけしました。
    `,
    isNew: false,
  },
  {
    id: 5,
    category: 'update',
    title: '【新機能】バッジ機能を追加しました',
    date: '2024-12-20',
    summary: '目標達成でバッジがもらえるゲーミフィケーション機能を追加しました。50種類以上のバッジを集めよう！',
    content: `
バッジ機能を追加しました！

【バッジの種類】
・連続記録バッジ（7日、30日、100日など）
・朝食マスター、野菜マニアなどの達成バッジ
・季節限定バッジ
・レアバッジ

プロフィール画面で獲得したバッジを確認できます。
全部集められるかな？
    `,
    isNew: false,
  },
  {
    id: 6,
    category: 'notice',
    title: '【お知らせ】年末年始の営業について',
    date: '2024-12-25',
    summary: '年末年始期間中のサポート対応についてお知らせします。',
    content: `
年末年始期間中のサポート対応についてお知らせします。

【サポート休業期間】
2024年12月29日〜2025年1月3日

この期間中にいただいたお問い合わせは、1月4日以降順次対応いたします。
アプリは通常通りご利用いただけます。

良いお年をお迎えください。
    `,
    isNew: false,
  },
];

export default function NewsPage() {
  const [activeCategory, setActiveCategory] = useState('all');
  const [selectedNews, setSelectedNews] = useState<typeof news[0] | null>(null);

  const filteredNews = news.filter(n => activeCategory === 'all' || n.category === activeCategory);

  const getCategoryInfo = (categoryId: string) => {
    switch (categoryId) {
      case 'update': return { color: colors.primary, bg: colors.primaryLight, label: 'アップデート' };
      case 'notice': return { color: colors.secondary, bg: colors.secondaryLight, label: 'お知らせ' };
      case 'maintenance': return { color: colors.warning, bg: colors.warningLight, label: 'メンテナンス' };
      default: return { color: colors.textMuted, bg: colors.bgAlt, label: '' };
    }
  };

  return (
    <div className="min-h-screen" style={{ background: colors.bg }}>
      {/* ヘッダー */}
      <header className="sticky top-0 z-50 border-b" style={{ background: colors.card, borderColor: colors.border }}>
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold" style={{ background: colors.primary }}>H</div>
            <span className="font-bold text-lg" style={{ color: colors.text }}>ほめゴハン</span>
          </Link>
          <Link href="/signup">
            <button className="text-sm font-bold px-4 py-2 text-white rounded-full" style={{ background: colors.primary }}>無料で始める</button>
          </Link>
        </div>
      </header>

      {/* メインコンテンツ */}
      <main className="container mx-auto px-4 py-12">
        {/* タイトル */}
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h1 className="text-4xl md:text-5xl font-bold mb-4" style={{ color: colors.text }}>
            📢 <span style={{ color: colors.primary }}>お知らせ</span>
          </h1>
          <p className="text-lg" style={{ color: colors.textLight }}>
            ほめゴハンの最新情報をお届けします。
          </p>
        </div>

        {/* カテゴリータブ */}
        <div className="flex flex-wrap justify-center gap-2 mb-8">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className="px-4 py-2 rounded-full text-sm font-medium transition-all flex items-center gap-2"
              style={{ 
                background: activeCategory === cat.id ? colors.primary : colors.card,
                color: activeCategory === cat.id ? 'white' : colors.textLight,
                border: `1px solid ${activeCategory === cat.id ? colors.primary : colors.border}`
              }}
            >
              {cat.icon}
              {cat.name}
            </button>
          ))}
        </div>

        {/* ニュース一覧 */}
        <div className="max-w-3xl mx-auto space-y-4">
          {filteredNews.map((item, i) => {
            const catInfo = getCategoryInfo(item.category);
            return (
              <motion.div
                key={item.id}
                className="p-5 rounded-2xl cursor-pointer group"
                style={{ background: colors.card, border: `1px solid ${colors.border}` }}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                whileHover={{ boxShadow: '0 4px 20px rgba(0,0,0,0.06)' }}
                onClick={() => setSelectedNews(item)}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ background: catInfo.bg, color: catInfo.color }}>
                        {catInfo.label}
                      </span>
                      {item.isNew && (
                        <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ background: colors.primaryLight, color: colors.primary }}>
                          NEW
                        </span>
                      )}
                      <span className="text-xs flex items-center gap-1" style={{ color: colors.textMuted }}>
                        <Calendar size={12} />
                        {item.date}
                      </span>
                    </div>
                    <h3 className="font-bold mb-2 group-hover:text-primary transition-colors" style={{ color: colors.text }}>
                      {item.title}
                    </h3>
                    <p className="text-sm line-clamp-2" style={{ color: colors.textLight }}>
                      {item.summary}
                    </p>
                  </div>
                  <ChevronRight size={20} className="flex-shrink-0 mt-1 group-hover:translate-x-1 transition-transform" style={{ color: colors.textMuted }} />
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* 詳細モーダル */}
        {selectedNews && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setSelectedNews(null)}>
            <div className="absolute inset-0 bg-black/50" />
            <motion.div
              className="relative w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-3xl p-6"
              style={{ background: colors.card }}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 mb-4">
                <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ background: getCategoryInfo(selectedNews.category).bg, color: getCategoryInfo(selectedNews.category).color }}>
                  {getCategoryInfo(selectedNews.category).label}
                </span>
                <span className="text-sm" style={{ color: colors.textMuted }}>{selectedNews.date}</span>
              </div>
              <h2 className="text-xl font-bold mb-4" style={{ color: colors.text }}>{selectedNews.title}</h2>
              <div className="prose prose-sm max-w-none">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed" style={{ color: colors.textLight }}>
                  {selectedNews.content}
                </pre>
              </div>
              <button
                onClick={() => setSelectedNews(null)}
                className="mt-6 w-full py-3 rounded-full font-bold"
                style={{ background: colors.bgAlt, color: colors.text }}
              >
                閉じる
              </button>
            </motion.div>
          </div>
        )}
      </main>

      {/* フッター */}
      <footer className="py-8 border-t mt-16" style={{ background: colors.card, borderColor: colors.border }}>
        <div className="container mx-auto px-4 text-center">
          <p className="text-sm" style={{ color: colors.textMuted }}>© 2025 ほめゴハン All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}

