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
  // #1867 (公開の主張の見直し): 紹介ページ (src/components/marketing/landing-copy.ts の claims) と同じく、製品の根拠のある主張だけを書く。
  // 写真で記録したときの「記録コメント」は、料理の名前と食事の区分だけが変わる定型の文 (supabase/functions/_shared/nutrition-pipeline.ts の buildTemplatePraiseAndTip) で、
  // 食事の中身を見て良いところを探す文ではない。撮り方の答えも、確かめていない認識の良し悪し (自然光・メニュー写真) を約束しない。
  // 戻らないことは tests/public-claims-guard.test.ts が確かめる
  { category: 'general', q: 'ほめゴハンとはどんなアプリですか？', a: 'ほめゴハンは、写真を撮るだけでAIが料理を認識して栄養を推定し、記録をほめてくれる食事記録アプリです。食事の記録の画面では、写真で記録すると、記録をほめるひと言と栄養のひと言メモが出ます。' },
  { category: 'general', q: 'どんな写真を撮ればいいですか？', a: '食事全体が写っていれば大丈夫です。真上からでも斜めからでもかまいません。明るい場所で、料理が重ならないように撮ってください。' },
  { category: 'general', q: 'おやつや夜食も記録できますか？', a: 'はい、朝食・昼食・夕食のほか、おやつや夜食も記録できます。' },
  { category: 'general', q: '過去の記録は見られますか？', a: 'はい、過去の記録も閲覧できます。' },
  // #1859: 画面の名前と条件の選択肢を、献立表の画面 (src/app/(main)/menus/weekly) と使い方ガイド (src/app/guide/guide-content.ts) に合わせた。
  // 画面に無い言い回しが戻らないこと・「」で挙げた名前が画面に実在することは tests/faq-guide-wording-1859.test.ts が確かめる
  { category: 'general', q: '献立提案機能はどう使いますか？', a: '献立表の画面で「AI献立アシスタント」（空欄があるときは「AIに埋めてもらう」）をタップすると、AIが1週間分の献立を自動生成します。作る範囲と、冷蔵庫優先・時短中心・和食多め・ヘルシーなどの条件も選べます（任意）。' },
  
  // アカウント
  { category: 'account', q: 'アカウント登録に必要なものは？', a: 'メールアドレスとパスワードで登録できます。Googleアカウントでのログインにも対応しています。' },
  { category: 'account', q: 'パスワードを忘れました', a: 'ログイン画面のパスワード欄の横にある「忘れた場合」（モバイルアプリでは「パスワードを忘れた？」）から、パスワード再設定のメールを送信できます。メール内のリンクから新しいパスワードを設定してください。再設定が終わると、セキュリティのため、すべての端末からログアウトされます。新しいパスワードでログインし直してください。' },
  // #1187: Web の設定画面に「アカウント」→「パスワード・メールアドレス」(/settings/account) を追加した。
  // モバイルアプリにも、設定画面の「アカウント」→「アカウント管理」(apps/mobile/app/settings/account.tsx) に同じ項目を追加した。
  // モバイルの項目はアプリの新しい版で届くので、古い版を使っている人向けに「最新版に更新」の一言を添えている
  { category: 'account', q: 'パスワードを変更したい', a: 'Web版では、設定画面の「アカウント」→「パスワード・メールアドレス」を開き、「パスワードを変更」に現在のパスワードと新しいパスワードを入力してください。モバイルアプリでは、設定画面の「アカウント」→「アカウント管理」を開き、「パスワードを変更」に同じように入力してください（項目が見当たらない場合は、アプリを最新版に更新してください）。変更すると、いま使っている端末以外のログインはすべて解除されます。現在のパスワードを思い出せないときは、ログイン画面の「忘れた場合」（モバイルアプリでは「パスワードを忘れた？」）からパスワードを再設定してください。Googleアカウントでログインしている場合、パスワードはGoogle側で管理されているため、ほめゴハンでは変更できません。' },
  { category: 'account', q: 'メールアドレスを変更したい', a: 'Web版では、設定画面の「アカウント」→「パスワード・メールアドレス」を開き、「メールアドレスを変更」に新しいメールアドレスを入力してください。モバイルアプリでは、設定画面の「アカウント」→「アカウント管理」を開き、「メールアドレスを変更」に新しいメールアドレスを入力してください（項目が見当たらない場合は、アプリを最新版に更新してください）。新しいメールアドレスに確認メールが届くので、メール内のリンクを開くと変更が完了します。セキュリティのため、現在のメールアドレスにも確認メールが届く場合があります。その場合は、両方のリンクを開いてください。確認が終わるまでは、これまでのメールアドレスでログインできます。Googleアカウントでログインしている場合、ログインに使うメールアドレスはGoogleアカウントのものです。変更したいときは、お問い合わせからご連絡ください。' },
  { category: 'account', q: 'アカウントを削除したい', a: 'Web版では、設定画面の一番下にある「危険ゾーン」→「アカウントを削除する」から削除できます。モバイルアプリでは、設定画面の「アカウント」→「アカウント管理」→「アカウント削除」から削除できます。削除すると全てのデータが消去され、復元できませんのでご注意ください。' },
  { category: 'account', q: '複数のデバイスで使えますか？', a: 'はい、同じアカウントで複数のデバイスからログインできます。データは自動で同期されます。' },
  
  // AI機能
  { category: 'ai', q: 'AIの分析は正確ですか？', a: 'AIによる分析はあくまで推定値で、料理や撮影条件によっては実際の値と異なる場合があります。医療目的での使用はお控えください。' },
  { category: 'ai', q: 'AIが認識できない料理はありますか？', a: '珍しい料理や、複数の料理が重なっている場合は認識精度が下がることがあります。その場合は手動で修正できます。' },
  // #1867 (Q-11): 写真の記録のコメントは AI が書く文ではなく、アプリの定型の文 (nutrition-pipeline.ts の buildTemplatePraiseAndTip)。
  // 「記録コメント」は AI が認識した料理の名前 (先頭 2 つ) と食事の区分を入れたひと言、「栄養メモ」は推定したタンパク質と食物繊維の量で選ぶひと言。
  // どちらも出すのは食事の記録の画面 (src/app/(main)/meals/new/page.tsx) だけ。AI が良いところを見つけて書くのは献立の振り返り
  // (src/app/api/ai/nutrition/feedback/route.ts の指示) だけ。紹介ページの claims の praise・nutrition-tip の行と同じ事実
  { category: 'ai', q: 'AIのコメントはどうやって生成されますか？', a: '食事の記録の画面では、写真で記録すると、解析の結果に「記録コメント」と「栄養メモ」が出ます。記録コメントは、AIが認識した料理の名前と食事の区分を入れて記録をほめる、決まった形のひと言です（料理の彩りや組み合わせを見て書く文ではありません）。栄養メモは、推定したタンパク質と食物繊維の量に合わせて選ぶ、栄養についてのひと言です。献立の振り返りでは、AIが献立の良いところを見つけて言葉にします。' },
  // #1870: 献立の生成が実際に使う情報に合わせた。根拠は supabase/functions/_shared/user-context.ts (アレルギー・苦手・好み・持病・目標)・
  // supabase/functions/generate-menu-v4/index.ts と generate-menu-v5/index.ts (冷蔵庫の食材 pantry_items・健康診断の結果 health_checkups・前後の日の献立)。
  // 生成は前後 7 日の献立 (planned_meals) を読み、同じ料理が続かないようにする。記録した食事も planned_meals の行なので、ここに含まれる。
  // 読み込んだ existingMenus では、「完了」にした食事 (is_completed = true) は status が "completed" の行になる (generate-menu-v4/index.ts と generate-menu-v5/index.ts)。
  // 写真から記録して献立表に保存した食事は未完了 (is_completed = false。src/app/api/meal-plans/add-from-photo/route.ts) で作られるので、完了にするまでは "completed" ではない行として読む。
  // 読むのはこの前後の日だけなので、「過去の食事記録」の分析とは書かない。
  // 挙げた情報が実コードで使われていることは tests/faq-guide-wording-1859.test.ts が確かめる
  { category: 'ai', q: '献立提案はどういう基準で作られますか？', a: 'あなたの目標（ダイエット、筋トレなど）と栄養の目標をもとに、栄養バランスを考えて献立を提案します。登録されていれば、アレルギー（その食材を使わないようにします）、苦手な食材（できるだけ避けます）、好きな食材や料理のジャンル、持病、健康診断の結果、冷蔵庫の食材も考慮します。また、前後の日の献立（記録した食事を含む）と同じ料理が続かないようにしています。' },
  
  // 料金・支払い
  // 1・2 の答えは @homegohan/shared の FREE_PLAN_FAQ_ANSWER・PAID_PLANS_FAQ_ANSWER の写し (billing/03 §10.5。一致は tests/billing-plan-catalog.test.ts が見る)
  { category: 'payment', q: '料金はかかりますか？', a: '無料プランでは、写真での食事の記録、記録をほめるひと言、献立の作成、健康の記録などをお使いいただけます。AIを使う機能（写真の解析や献立の作成など）は、1日にご利用いただける回数に上限があり、上限に達した日は翌日0時からまたお使いいただけます。無料プランの上限は1日3回です。有料プランでは、AI を使う回数の上限が上がり、究極モード・料理画像の作成・家族グループが使えます。' },
  { category: 'payment', q: '有料プランはありますか？', a: '個人 Pro (月額 580円 / 年額 5,800円)、家族 Basic (月額 980円 / 年額 9,800円・4 人まで)、家族 Pro (月額 1,480円 / 年額 14,800円・8 人まで)があります。Web でお申し込みの場合、どのプランも 7 日間の無料体験つきです (同じプランにつき 1 回)。App Store・Google Play でお申し込みの場合の無料体験は、各ストアの表示によります。' },
  { category: 'payment', q: '返金はできますか？', a: 'Web でお申し込みの場合、原則として返金には対応しておりません。ただし、サービスに重大な問題があった場合は個別に対応いたします。App Store / Google Play でお申し込みの場合の返金は、各ストアの規定によります。' },
  { category: 'payment', q: '有料プランを解約するには？', a: 'Web でお申し込みの方は、設定の「プランとお支払い」から解約できます。App Store / Google Play でお申し込みの方は、各ストアの定期購読の管理から解約してください。解約後も、お支払い済みの期間の終わりまでご利用いただけます。' },
  
  // データ・プライバシー
  // データの取り扱いの最終的な文言は、プライバシーポリシーの見直しと合わせて決める。それまでは断定せず、プライバシーポリシーへ案内する。
  { category: 'data', q: '写真データはどこに保存されますか？', a: '暗号化された安全なクラウドサーバーの、公開されない保存領域に保存されます。URL を知っているだけでは閲覧できず、表示するときはログインしたご本人のために有効期限つきの URL を発行します。データの取り扱いの詳細は、プライバシーポリシーをご確認ください。' },
  // #1870: 設定画面に、その場でデータだけを消す項目は無い。あるのはアカウントの削除と、開示・訂正・利用停止・消去の請求の入口
  // (見出しは packages/shared/src/data-subject-requests.ts の DSR_SETTINGS_ENTRY_TITLE。Web は設定の「データとプライバシー」、
  // アプリはアカウントの画面 (apps/mobile/app/settings/account.tsx) にあり、どちらも Web の請求の画面を開く) なので、実態に合わせて書き直した。
  // 請求の流れ (本人確認のメール → 受付) は src/app/(main)/settings/data-requests/page.tsx の案内の文と同じ。
  // 同じ画面の送信ボタンは、請求の種類を選び「請求の内容」を書くまで押せない (canSubmit) ので、両方の手順を書く
  { category: 'data', q: 'データを削除できますか？', a: 'はい。アカウントを削除すると、ご自身のデータはすべて消去され、復元できません。アカウントは残したまま一部のデータだけを消したいときは、消去を請求できます。Web版では、設定画面の「データとプライバシー」→「開示・訂正・利用停止の請求」を開き、請求の種類で消去を選び、「請求の内容」に消したいデータを書いて送信してください。モバイルアプリでは、設定画面の「アカウント」→「アカウント管理」→「開示・訂正・利用停止の請求」から、同じ画面を開けます。送信すると、登録のメールアドレスに本人確認のメールが届きます。メールのリンクを開くと受付になり、運営が内容を確認して対応します。' },
  { category: 'data', q: 'データは第三者に共有されますか？', a: 'データの取り扱い（第三者への提供を含む）については、プライバシーポリシーをご確認ください。' },
  // #1870: Web とモバイルアプリで項目の名前が違うので、それぞれの場所を書く。CSV の中身はどちらも献立 (planned_meals。/api/export/meals)。
  // 「」の名前が、Web は Web の画面のソース、モバイルアプリはアプリのソースに実在することは tests/faq-guide-wording-1859.test.ts が確かめる
  { category: 'data', q: 'データをエクスポートできますか？', a: 'はい、できます。Web版では、設定画面の「データとプライバシー」にある「データをエクスポート」から、ご自身のデータをJSON形式でダウンロードできます。献立は「献立をCSVエクスポート」でCSV形式でも保存できます。モバイルアプリでは、設定画面の「データとプライバシー」にある「JSONでエクスポート」（ご自身のデータ）と「CSVでエクスポート」（献立）から、同じ内容を保存できます。' },
  
  // トラブルシューティング
  { category: 'trouble', q: '写真が認識されません', a: '明るい場所で撮影し、食事全体が写るようにしてください。それでも認識されない場合は、アプリを再起動してお試しください。' },
  { category: 'trouble', q: 'アプリが重い・落ちる', a: 'アプリを最新バージョンに更新してください。それでも改善しない場合は、端末の再起動をお試しください。' },
  { category: 'trouble', q: '通知が届きません', a: '端末の設定でほめゴハンの通知が許可されているか確認してください。アプリ内の設定でも通知のオン/オフを切り替えられます。' },
  { category: 'trouble', q: 'ログインできません', a: 'パスワードが正しいか確認してください。それでもログインできない場合は、ログイン画面の「忘れた場合」（モバイルアプリでは「パスワードを忘れた？」）からパスワードを再設定してください。' },
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
            通常2〜3営業日以内にご返信いたします。
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

