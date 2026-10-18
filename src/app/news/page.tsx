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

/** お知らせが 1 件も無いときに出す文 */
const NO_NEWS_MESSAGE = '現在、お知らせはありません。';

/** お知らせの 1 件 */
interface NewsItem {
  id: number;
  category: 'update' | 'notice' | 'maintenance';
  title: string;
  /** 掲載日 (YYYY-MM-DD) */
  date: string;
  summary: string;
  content: string;
  isNew: boolean;
}

/**
 * お知らせの一覧 (新しい順)。実際にあったことだけを載せる。
 * #1867 (公開の主張の見直し): 以前ここにあった 5 件は、このリポジトリの最初のコミット (2025-11-24) より前の日付 (2024-12〜2025-01) の
 * リリース・メンテナンス・年末年始の休業のお知らせで、根拠の無い数字 (認識精度の向上率・バッジの種類の数) や、
 * 製品に無いバッジ (30日・100日の連続記録・季節限定など。付くバッジは src/lib/badges/awardable.ts) を含んでいたので取り下げた。
 * 戻らないことは tests/public-claims-guard.test.ts が確かめる
 */
const news: readonly NewsItem[] = [];

export default function NewsPage() {
  const [activeCategory, setActiveCategory] = useState('all');
  const [selectedNews, setSelectedNews] = useState<NewsItem | null>(null);

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
          {filteredNews.length === 0 && (
            <p className="text-center py-12" style={{ color: colors.textMuted }}>
              {NO_NEWS_MESSAGE}
            </p>
          )}
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

