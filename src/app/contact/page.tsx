"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Mail, MessageSquare, HelpCircle, Bug, Lightbulb, CheckCircle2, Send, ChevronRight } from "lucide-react";

const colors = {
  primary: '#E07A5F',
  primaryLight: '#FDF0ED',
  bg: '#FAF9F7',
  bgAlt: '#F5F3EF',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#8A8A8A',
  border: '#E8E8E8',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
};

const INQUIRY_TYPES = [
  { value: 'general', label: '一般的なお問い合わせ', icon: MessageSquare },
  { value: 'support', label: 'サポート・ヘルプ', icon: HelpCircle },
  { value: 'bug', label: 'バグ・不具合の報告', icon: Bug },
  { value: 'feature', label: '機能のリクエスト', icon: Lightbulb },
];

export default function ContactPage() {
  const [formData, setFormData] = useState({
    inquiryType: 'general',
    email: '',
    subject: '',
    message: '',
  });
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || '送信に失敗しました');
      }
      
      setSuccess(true);
      setFormData({
        inquiryType: 'general',
        email: '',
        subject: '',
        message: '',
      });
    } catch (err: any) {
      setError(err.message || '送信に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen" style={{ background: colors.bg }}>
      {/* ヘッダー */}
      <header className="sticky top-0 z-50 border-b" style={{ background: colors.card, borderColor: colors.border }}>
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="p-2 -ml-2 rounded-full hover:bg-gray-100 transition-colors">
              <ArrowLeft size={20} style={{ color: colors.text }} />
            </Link>
            <Link href="/" className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold" style={{ background: colors.primary }}>H</div>
              <span className="font-bold text-lg" style={{ color: colors.text }}>ほめゴハン</span>
            </Link>
          </div>
          <Link href="/signup">
            <button className="text-sm font-bold px-4 py-2 text-white rounded-full" style={{ background: colors.primary }}>無料で始める</button>
          </Link>
        </div>
      </header>

      {/* メインコンテンツ */}
      <main className="container mx-auto px-4 py-12 max-w-2xl">
        <AnimatePresence mode="wait">
          {success ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="p-8 rounded-3xl text-center"
              style={{ background: colors.card }}
            >
              <div 
                className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6"
                style={{ background: colors.successLight }}
              >
                <CheckCircle2 size={40} style={{ color: colors.success }} />
              </div>
              <h2 className="text-2xl font-bold mb-3" style={{ color: colors.text }}>
                送信完了しました！
              </h2>
              <p className="mb-6" style={{ color: colors.textLight }}>
                お問い合わせありがとうございます。<br />
                内容を確認の上、2〜3営業日以内にご連絡いたします。
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button
                  onClick={() => setSuccess(false)}
                  className="px-6 py-3 rounded-xl font-medium"
                  style={{ background: colors.bgAlt, color: colors.textLight }}
                >
                  新しいお問い合わせ
                </button>
                <Link href="/">
                  <button
                    className="px-6 py-3 rounded-xl font-bold text-white"
                    style={{ background: colors.primary }}
                  >
                    トップページへ
                  </button>
                </Link>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="form"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              {/* タイトル */}
              <div className="text-center mb-8">
                <h1 className="text-3xl md:text-4xl font-bold mb-4" style={{ color: colors.text }}>
                  📬 <span style={{ color: colors.primary }}>お問い合わせ</span>
                </h1>
                <p style={{ color: colors.textLight }}>
                  ご質問、ご要望、不具合の報告など、お気軽にお問い合わせください。<br />
                  通常2〜3営業日以内にご返信いたします。
                </p>
              </div>

              {/* フォーム */}
              <div className="p-6 md:p-8 rounded-3xl" style={{ background: colors.card, border: `1px solid ${colors.border}` }}>
                <form onSubmit={handleSubmit} className="space-y-6">
                  {/* お問い合わせ種別 */}
                  <div>
                    <label className="block text-sm font-bold mb-3" style={{ color: colors.text }}>
                      お問い合わせ種別
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      {INQUIRY_TYPES.map((type) => {
                        const Icon = type.icon;
                        const isSelected = formData.inquiryType === type.value;
                        return (
                          <button
                            key={type.value}
                            type="button"
                            onClick={() => setFormData({ ...formData, inquiryType: type.value })}
                            className="p-4 rounded-xl text-left flex items-center gap-3 transition-all"
                            style={{
                              background: isSelected ? colors.primaryLight : colors.bgAlt,
                              border: `2px solid ${isSelected ? colors.primary : 'transparent'}`,
                            }}
                          >
                            <Icon 
                              size={20} 
                              style={{ color: isSelected ? colors.primary : colors.textMuted }} 
                            />
                            <span 
                              className="text-sm font-medium"
                              style={{ color: isSelected ? colors.primary : colors.textLight }}
                            >
                              {type.label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* メールアドレス */}
                  <div>
                    <label className="block text-sm font-bold mb-2" style={{ color: colors.text }}>
                      メールアドレス <span style={{ color: colors.primary }}>*</span>
                    </label>
                    <div className="relative">
                      <Mail 
                        size={18} 
                        className="absolute left-4 top-1/2 -translate-y-1/2"
                        style={{ color: colors.textMuted }}
                      />
                      <input
                        type="email"
                        value={formData.email}
                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                        placeholder="example@email.com"
                        required
                        className="w-full pl-12 pr-4 py-3 rounded-xl border outline-none focus:ring-2 transition-all"
                        style={{ 
                          background: colors.bgAlt,
                          borderColor: colors.border,
                          color: colors.text,
                        }}
                      />
                    </div>
                  </div>

                  {/* 件名 */}
                  <div>
                    <label className="block text-sm font-bold mb-2" style={{ color: colors.text }}>
                      件名 <span style={{ color: colors.primary }}>*</span>
                    </label>
                    <input
                      type="text"
                      value={formData.subject}
                      onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                      placeholder="お問い合わせの件名"
                      required
                      className="w-full px-4 py-3 rounded-xl border outline-none focus:ring-2 transition-all"
                      style={{ 
                        background: colors.bgAlt,
                        borderColor: colors.border,
                        color: colors.text,
                      }}
                    />
                  </div>

                  {/* メッセージ */}
                  <div>
                    <label className="block text-sm font-bold mb-2" style={{ color: colors.text }}>
                      お問い合わせ内容 <span style={{ color: colors.primary }}>*</span>
                    </label>
                    <textarea
                      value={formData.message}
                      onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                      placeholder="お問い合わせ内容をご記入ください"
                      required
                      rows={6}
                      className="w-full px-4 py-3 rounded-xl border outline-none focus:ring-2 transition-all resize-none"
                      style={{ 
                        background: colors.bgAlt,
                        borderColor: colors.border,
                        color: colors.text,
                      }}
                    />
                  </div>

                  {/* エラー表示 */}
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-4 rounded-xl text-sm"
                      style={{ background: '#FFEBEE', color: '#D32F2F' }}
                    >
                      {error}
                    </motion.div>
                  )}

                  {/* 送信ボタン */}
                  <motion.button
                    type="submit"
                    disabled={loading}
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.99 }}
                    className="w-full py-4 rounded-xl font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                    style={{ background: colors.primary }}
                  >
                    {loading ? (
                      <>
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        送信中...
                      </>
                    ) : (
                      <>
                        <Send size={18} />
                        送信する
                      </>
                    )}
                  </motion.button>
                </form>
              </div>

              {/* FAQ リンク */}
              <div className="mt-8 p-6 rounded-3xl" style={{ background: colors.card, border: `1px solid ${colors.border}` }}>
                <h3 className="font-bold mb-3" style={{ color: colors.text }}>
                  よくある質問
                </h3>
                <p className="text-sm mb-4" style={{ color: colors.textMuted }}>
                  お問い合わせの前に、よくある質問をご確認ください。
                </p>
                <div className="space-y-2">
                  {[
                    { label: 'アカウントの削除方法', href: '/faq#account' },
                    { label: 'データのエクスポート', href: '/faq#data' },
                    { label: '料金プランについて', href: '/pricing' },
                  ].map((faq, i) => (
                    <Link
                      key={i}
                      href={faq.href}
                      className="w-full text-left p-3 rounded-xl text-sm font-medium flex items-center justify-between hover:bg-gray-50 transition-colors"
                      style={{ background: colors.bgAlt, color: colors.textLight }}
                    >
                      <span>{faq.label}</span>
                      <ChevronRight size={16} style={{ color: colors.primary }} />
                    </Link>
                  ))}
                </div>
              </div>

              {/* 連絡先情報 */}
              <div className="mt-6 text-center">
                <p className="text-sm" style={{ color: colors.textMuted }}>
                  お急ぎの場合は直接メールでもお問い合わせいただけます
                </p>
                <a 
                  href="mailto:support@homegohan.jp"
                  className="text-sm font-bold hover:underline"
                  style={{ color: colors.primary }}
                >
                  support@homegohan.jp
                </a>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
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

