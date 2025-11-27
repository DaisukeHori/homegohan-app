"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Mail, MessageSquare, HelpCircle, Bug, Lightbulb, CheckCircle2, Send } from "lucide-react";

const colors = {
  bg: '#FAF9F7',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#9A9A9A',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  border: '#EEEEEE',
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
      // 実際の送信処理（メール送信APIなど）
      // ここではデモとして成功を返す
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // 成功
      setSuccess(true);
      setFormData({
        inquiryType: 'general',
        email: '',
        subject: '',
        message: '',
      });
    } catch (err: any) {
      setError('送信に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4" style={{ backgroundColor: colors.bg }}>
        <div className="flex items-center">
          <Link href="/home" className="p-2 -ml-2">
            <ArrowLeft size={24} style={{ color: colors.text }} />
          </Link>
          <h1 className="font-bold ml-2" style={{ color: colors.text }}>お問い合わせ</h1>
        </div>
      </div>

      <div className="px-6">
        <AnimatePresence mode="wait">
          {success ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="p-8 rounded-3xl text-center"
              style={{ backgroundColor: colors.card }}
            >
              <div 
                className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6"
                style={{ backgroundColor: '#E8F5E9' }}
              >
                <CheckCircle2 size={32} className="text-green-500" />
              </div>
              <h2 className="text-xl font-bold mb-2" style={{ color: colors.text }}>
                送信完了
              </h2>
              <p className="text-sm mb-6" style={{ color: colors.textMuted }}>
                お問い合わせありがとうございます。<br />
                内容を確認の上、ご連絡いたします。
              </p>
              <button
                onClick={() => setSuccess(false)}
                className="px-6 py-3 rounded-xl font-medium"
                style={{ backgroundColor: colors.bg, color: colors.textLight }}
              >
                新しいお問い合わせ
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="form"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              {/* 説明 */}
              <div className="mb-6">
                <p className="text-sm" style={{ color: colors.textMuted }}>
                  ご質問、ご要望、不具合の報告など、お気軽にお問い合わせください。
                  通常2〜3営業日以内にご返信いたします。
                </p>
              </div>

              {/* お問い合わせフォーム */}
              <form onSubmit={handleSubmit} className="space-y-6">
                {/* お問い合わせ種別 */}
                <div>
                  <label className="block text-sm font-medium mb-3" style={{ color: colors.textLight }}>
                    お問い合わせ種別
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {INQUIRY_TYPES.map((type) => {
                      const Icon = type.icon;
                      const isSelected = formData.inquiryType === type.value;
                      return (
                        <button
                          key={type.value}
                          type="button"
                          onClick={() => setFormData({ ...formData, inquiryType: type.value })}
                          className="p-3 rounded-xl text-left flex items-center gap-2 transition-colors"
                          style={{
                            backgroundColor: isSelected ? colors.accentLight : colors.card,
                            border: `2px solid ${isSelected ? colors.accent : colors.border}`,
                          }}
                        >
                          <Icon 
                            size={18} 
                            style={{ color: isSelected ? colors.accent : colors.textMuted }} 
                          />
                          <span 
                            className="text-sm font-medium"
                            style={{ color: isSelected ? colors.accent : colors.textLight }}
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
                  <label className="block text-sm font-medium mb-2" style={{ color: colors.textLight }}>
                    メールアドレス <span style={{ color: colors.accent }}>*</span>
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
                      className="w-full pl-12 pr-4 py-3 rounded-xl border outline-none transition-colors"
                      style={{ 
                        backgroundColor: colors.card,
                        borderColor: colors.border,
                        color: colors.text,
                      }}
                    />
                  </div>
                </div>

                {/* 件名 */}
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: colors.textLight }}>
                    件名 <span style={{ color: colors.accent }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.subject}
                    onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                    placeholder="お問い合わせの件名"
                    required
                    className="w-full px-4 py-3 rounded-xl border outline-none transition-colors"
                    style={{ 
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                      color: colors.text,
                    }}
                  />
                </div>

                {/* メッセージ */}
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: colors.textLight }}>
                    お問い合わせ内容 <span style={{ color: colors.accent }}>*</span>
                  </label>
                  <textarea
                    value={formData.message}
                    onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                    placeholder="お問い合わせ内容をご記入ください"
                    required
                    rows={6}
                    className="w-full px-4 py-3 rounded-xl border outline-none transition-colors resize-none"
                    style={{ 
                      backgroundColor: colors.card,
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
                    className="p-3 rounded-xl text-sm"
                    style={{ backgroundColor: '#FFEBEE', color: '#F44336' }}
                  >
                    {error}
                  </motion.div>
                )}

                {/* 送信ボタン */}
                <motion.button
                  type="submit"
                  disabled={loading}
                  whileTap={{ scale: 0.98 }}
                  className="w-full py-4 rounded-xl font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                  style={{ backgroundColor: colors.accent }}
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

              {/* FAQ リンク */}
              <div 
                className="mt-8 p-4 rounded-2xl"
                style={{ backgroundColor: colors.card }}
              >
                <h3 className="font-semibold mb-2" style={{ color: colors.text }}>
                  よくある質問
                </h3>
                <p className="text-sm mb-3" style={{ color: colors.textMuted }}>
                  お問い合わせの前に、よくある質問をご確認ください。
                </p>
                <div className="space-y-2">
                  {[
                    'アカウントの削除方法',
                    'データのエクスポート',
                    '料金プランについて',
                  ].map((faq, i) => (
                    <button
                      key={i}
                      className="w-full text-left p-3 rounded-xl text-sm font-medium flex items-center justify-between"
                      style={{ backgroundColor: colors.bg, color: colors.textLight }}
                    >
                      <span>{faq}</span>
                      <span style={{ color: colors.accent }}>→</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 連絡先情報 */}
              <div className="mt-6 text-center">
                <p className="text-sm" style={{ color: colors.textMuted }}>
                  お急ぎの場合は直接メールでもお問い合わせいただけます
                </p>
                <a 
                  href="mailto:support@homegohan.example.com"
                  className="text-sm font-medium hover:underline"
                  style={{ color: colors.accent }}
                >
                  support@homegohan.example.com
                </a>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

