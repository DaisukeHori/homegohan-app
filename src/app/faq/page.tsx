"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Search, MessageCircle, HelpCircle, ArrowRight } from "lucide-react";

const colors = {
  primary: '#E07A5F',
  primaryLight: '#FDF0ED',
  secondary: '#3D5A80',
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

const categories = [
  { id: 'general', name: '基本的な使い方', icon: '📱' },
  { id: 'account', name: 'アカウント', icon: '👤' },
  { id: 'ai', name: 'AI機能', icon: '🤖' },
  { id: 'payment', name: '料金・支払い', icon: '💳' },
  { id: 'data', name: 'データ・プライバシー', icon: '🔒' },
  { id: 'trouble', name: 'トラブルシューティング', icon: '🔧' },
];

const faqs = [
  // 基本的な使い方
  { category: 'general', q: 'ほめゴハンとはどんなアプリですか？', a: 'ほめゴハンは、写真を撮るだけで食事の栄養バランスをAIが分析し、良いところを褒めてくれる食事管理アプリです。ダメ出しではなく褒めることで、楽しく続けられるのが特徴です。' },
  { category: 'general', q: 'どんな写真を撮ればいいですか？', a: '食事全体が写っていれば大丈夫です。真上からでも斜めからでもOK。自然光で撮ると認識精度が上がります。お店のメニュー写真でも問題なく分析できます。' },
  { category: 'general', q: '1日に何回まで記録できますか？', a: '無料プランでは1日3食まで、プレミアムプランでは無制限に記録できます。おやつや夜食も記録可能です。' },
  { category: 'general', q: '過去の記録は見られますか？', a: 'はい、見られます。無料プランでは過去30日分、プレミアムプランでは無制限に過去データを閲覧できます。' },
  { category: 'general', q: '献立提案機能はどう使いますか？', a: 'メニュー画面から「AIに献立を提案してもらう」をタップすると、AIが1週間分の献立を自動生成します。予算や調理時間などの条件も設定できます。' },
  
  // アカウント
  { category: 'account', q: 'アカウント登録に必要なものは？', a: 'メールアドレスのみで登録できます。Googleアカウントでのログインにも対応しています。' },
  { category: 'account', q: 'パスワードを忘れました', a: 'ログイン画面の「パスワードを忘れた方」からパスワードリセットメールを送信できます。メール内のリンクから新しいパスワードを設定してください。' },
  { category: 'account', q: 'メールアドレスを変更したい', a: '設定画面の「アカウント」から変更できます。新しいメールアドレスに確認メールが届きますので、認証を完了してください。' },
  { category: 'account', q: 'アカウントを削除したい', a: '設定画面の「アカウント」→「アカウント削除」から削除できます。削除すると全てのデータが消去され、復元できませんのでご注意ください。' },
  { category: 'account', q: '複数のデバイスで使えますか？', a: 'はい、同じアカウントで複数のデバイスからログインできます。データは自動で同期されます。' },
  
  // AI機能
  { category: 'ai', q: 'AIの分析は正確ですか？', a: '最新のAI技術を使用しており、一般的な料理であれば90%以上の精度で認識できます。ただし、あくまで推定値ですので、医療目的での使用はお控えください。' },
  { category: 'ai', q: 'AIが認識できない料理はありますか？', a: '珍しい料理や、複数の料理が重なっている場合は認識精度が下がることがあります。その場合は手動で修正できます。' },
  { category: 'ai', q: 'AIのコメントはどうやって生成されますか？', a: '食事の栄養バランス、食材の組み合わせ、過去の記録などを総合的に分析し、良いところを見つけてコメントを生成しています。' },
  { category: 'ai', q: '献立提案はどういう基準で作られますか？', a: 'あなたの目標（ダイエット、筋トレなど）、食材の好み、過去の食事記録、栄養バランスなどを考慮して最適な献立を提案します。' },
  
  // 料金・支払い
  { category: 'payment', q: '無料プランはいつまで使えますか？', a: '永久無料です！基本機能は今後も無料でご利用いただけます。課金を強制することは一切ありません。' },
  { category: 'payment', q: 'プレミアムプランの料金は？', a: '月額980円（税込）です。年払いの場合は9,800円（税込）で2ヶ月分お得になります。' },
  { category: 'payment', q: '支払い方法は？', a: 'クレジットカード（Visa、Mastercard、JCB、American Express）に対応しています。' },
  { category: 'payment', q: '解約はいつでもできますか？', a: 'はい、いつでも解約できます。解約後も次回更新日まではプレミアム機能をご利用いただけます。' },
  { category: 'payment', q: '返金はできますか？', a: '原則として返金には対応しておりません。ただし、サービスに重大な問題があった場合は個別に対応いたします。' },
  
  // データ・プライバシー
  { category: 'data', q: '写真データはどこに保存されますか？', a: '暗号化された安全なクラウドサーバーに保存されます。第三者がアクセスすることはできません。' },
  { category: 'data', q: 'データを削除できますか？', a: 'はい、設定画面からいつでもデータを削除できます。アカウント削除時には全てのデータが完全に消去されます。' },
  { category: 'data', q: 'データは第三者に共有されますか？', a: 'いいえ、あなたのデータを第三者に共有・販売することは一切ありません。' },
  { category: 'data', q: 'データをエクスポートできますか？', a: 'プレミアムプランでは、食事記録や健康データをCSV形式でエクスポートできます。' },
  
  // トラブルシューティング
  { category: 'trouble', q: '写真が認識されません', a: '明るい場所で撮影し、食事全体が写るようにしてください。それでも認識されない場合は、アプリを再起動してお試しください。' },
  { category: 'trouble', q: 'アプリが重い・落ちる', a: 'アプリを最新バージョンに更新してください。それでも改善しない場合は、端末の再起動をお試しください。' },
  { category: 'trouble', q: '通知が届きません', a: '端末の設定でほめゴハンの通知が許可されているか確認してください。アプリ内の設定でも通知のオン/オフを切り替えられます。' },
  { category: 'trouble', q: 'ログインできません', a: 'パスワードが正しいか確認してください。それでもログインできない場合は「パスワードを忘れた方」からリセットしてください。' },
];

export default function FaqPage() {
  const [activeCategory, setActiveCategory] = useState('general');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);

  const filteredFaqs = faqs.filter(faq => {
    const matchesCategory = activeCategory === 'all' || faq.category === activeCategory;
    const matchesSearch = searchQuery === '' || 
      faq.q.toLowerCase().includes(searchQuery.toLowerCase()) || 
      faq.a.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

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
            ❓ <span style={{ color: colors.primary }}>よくある質問</span>
          </h1>
          <p className="text-lg mb-8" style={{ color: colors.textLight }}>
            お困りのことがあればこちらをご確認ください。<br />
            見つからない場合はお問い合わせフォームからご連絡ください。
          </p>

          {/* 検索 */}
          <div className="relative max-w-md mx-auto">
            <Search size={20} className="absolute left-4 top-1/2 -translate-y-1/2" style={{ color: colors.textMuted }} />
            <input
              type="text"
              placeholder="キーワードで検索..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-12 pr-4 py-3 rounded-full border focus:outline-none focus:ring-2"
              style={{ background: colors.card, borderColor: colors.border, color: colors.text }}
            />
          </div>
        </div>

        {/* カテゴリータブ */}
        <div className="flex flex-wrap justify-center gap-2 mb-8">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => { setActiveCategory(cat.id); setExpandedFaq(null); }}
              className="px-4 py-2 rounded-full text-sm font-medium transition-all flex items-center gap-2"
              style={{ 
                background: activeCategory === cat.id ? colors.primary : colors.card,
                color: activeCategory === cat.id ? 'white' : colors.textLight,
                border: `1px solid ${activeCategory === cat.id ? colors.primary : colors.border}`
              }}
            >
              <span>{cat.icon}</span>
              {cat.name}
            </button>
          ))}
        </div>

        {/* FAQ一覧 */}
        <div className="max-w-3xl mx-auto space-y-3">
          {filteredFaqs.length === 0 ? (
            <div className="text-center py-12">
              <HelpCircle size={48} className="mx-auto mb-4" style={{ color: colors.textMuted }} />
              <p style={{ color: colors.textMuted }}>該当する質問が見つかりませんでした</p>
            </div>
          ) : (
            filteredFaqs.map((faq, i) => (
              <motion.div
                key={i}
                className="rounded-2xl overflow-hidden"
                style={{ background: colors.card, border: `1px solid ${colors.border}` }}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
              >
                <button
                  onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
                  className="w-full p-5 flex items-center justify-between text-left"
                >
                  <span className="font-bold pr-4 flex items-center gap-3" style={{ color: colors.text }}>
                    <MessageCircle size={18} style={{ color: colors.primary }} />
                    {faq.q}
                  </span>
                  <motion.div animate={{ rotate: expandedFaq === i ? 180 : 0 }} transition={{ duration: 0.2 }}>
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
                      <div className="px-5 pb-5">
                        <div className="p-4 rounded-xl" style={{ background: colors.bgAlt }}>
                          <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>{faq.a}</p>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))
          )}
        </div>

        {/* お問い合わせ */}
        <div className="text-center mt-16 p-8 rounded-3xl max-w-2xl mx-auto" style={{ background: colors.primaryLight }}>
          <h3 className="text-xl font-bold mb-2" style={{ color: colors.text }}>解決しませんでしたか？</h3>
          <p className="text-sm mb-4" style={{ color: colors.textLight }}>
            お問い合わせフォームからお気軽にご連絡ください。<br />
            通常24時間以内にご返信いたします。
          </p>
          <Link href="/contact">
            <motion.button
              className="px-6 py-3 rounded-full font-bold text-white inline-flex items-center gap-2"
              style={{ background: colors.primary }}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.98 }}
            >
              お問い合わせ <ArrowRight size={18} />
            </motion.button>
          </Link>
        </div>
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

