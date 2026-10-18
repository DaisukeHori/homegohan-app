// src/components/marketing/landing-copy.ts
// 紹介ページ (/) の文言・画像・公開の主張・デモの見本・動きの定数の正本。ここだけを直せば、月に数回の更新が済む。
// claims は docs/design/marketing/01-landing-site.md §4.1 の公開の主張の表と同じ行 (id・文・根拠のパス・条件) を持つ。
// 根拠のパスの実在とデモの見本の式は tests/landing-page-1867.test.ts が、載せてはいけない語は tests/public-claims-guard.test.ts が見る。
// 絵文字は書かない (アイコンは各部品が lucide-react から import する)。ドメイン (homegohan.*) は書かない (tests/site-config-guard.test.ts)。
import { z } from 'zod';
import { SITE_NAME } from '@/lib/site-config';

/** ページが指す public/ の画像 (ガイドの画面写真か、紹介ページの写真)。実在は tests/metadata-public-paths-1845.test.ts と U-4 が見る */
export const LANDING_IMAGE_PATH_PATTERN = /^\/(?:guide\/[a-z-]+\.png|marketing\/photos\/[a-z-]+\.webp)$/;
/** 主張の根拠に書けるパス (リポジトリの根からの相対。ディレクトリは末尾 /)。.. を含まない */
export const EVIDENCE_PATH_PATTERN = /^(?:src|tests|supabase|packages|apps)\/[^\s]+$/;

/** サイトの中のリンク先 (先頭が / か #)。外部の URL は紹介ページに置かない */
const InternalHrefSchema = z.string().regex(/^(?:\/[a-z0-9\-/]*|#[a-z0-9-]+)$/);
const ImagePathSchema = z.string().regex(LANDING_IMAGE_PATH_PATTERN);
const EvidencePathSchema = z.string().regex(EVIDENCE_PATH_PATTERN);

export const LandingImageSchema = z.object({ src: ImagePathSchema, alt: z.string().min(1) });
export const LandingLinkSchema = z.object({ label: z.string().min(1), href: InternalHrefSchema });

/** 公開の主張の id (§4.1 の表の 17 行と同じ順) */
export const CLAIM_IDS = [
  'photo-analyze',
  'praise',
  'nutrition-tip',
  'demo-sample',
  'weekly-menu',
  'shopping-list',
  'health-records',
  'badges',
  'fridge',
  'family',
  'free-now',
  'ai-daily-limit',
  'ai-consent',
  'no-card',
  'delete-export',
  'ai-estimate',
  'privacy',
] as const;

/** 公開の主張。text は主張の文、evidence は根拠のパス (1 つ以上)、condition は主張が成り立つ条件 (無ければ null) */
export const LandingClaimSchema = z.object({
  id: z.enum(CLAIM_IDS),
  text: z.string().min(1),
  evidence: z.array(EvidencePathSchema).min(1),
  condition: z.string().min(1).nullable(),
});

// ─── デモの記録コメント (アプリの定型の文と同じ形。§4.5) ───
/** 記録コメントの句。nutrition-pipeline.ts の buildTemplatePraiseAndTip の定型の文と同じ (U-21 がソースと突き合わせる) */
export const DEMO_PRAISE_DISH_SUFFIX = 'の記録';
export const DEMO_PRAISE_RECORD_PHRASE = 'がしっかりできていて素晴らしいです。';
export const DEMO_PRAISE_MEAL_PHRASE = 'を丁寧に残せていて、とても良い流れです';
/** 記録コメントの文の終わり。アプリは絵文字で終わるが、紹介ページは絵文字を使わない (U-9) ので句点にする */
export const DEMO_PRAISE_END = '。';
/** 記録コメントに入れる料理の名前の数の上限 (アプリの slice(0, 2) と同じ) */
export const DEMO_PRAISE_MAX_DISHES = 2;
/** 料理の名前をつなぐ文字 (アプリの join('、') と同じ) */
export const DEMO_PRAISE_DISH_SEPARATOR = '、';
/** 食事の区分の語。アプリの toMealTypeLabel が返す語のうち、デモで使うもの */
export const DEMO_MEAL_TYPE_LABELS = ['朝食', '昼食', '夕食'] as const;

// ─── デモのスコア (アプリの overallScore と同じ式。§4.5 の「ソースの式」。U-21 がソースと突き合わせる) ───
/** スコアの土台の点 */
export const DEMO_SCORE_BASE = 70;
/** スコアの下限と上限 (アプリは Math.max(70, Math.min(95, …)) で収める) */
export const DEMO_SCORE_MIN = 70;
export const DEMO_SCORE_MAX = 95;
/** タンパク質の点 = min(DEMO_SCORE_PROTEIN_CAP, タンパク質 g ÷ DEMO_SCORE_PROTEIN_DIVISOR) */
export const DEMO_SCORE_PROTEIN_DIVISOR = 3;
export const DEMO_SCORE_PROTEIN_CAP = 10;
/** 食物繊維の点 = min(DEMO_SCORE_FIBER_CAP, 食物繊維 g × DEMO_SCORE_FIBER_FACTOR) */
export const DEMO_SCORE_FIBER_FACTOR = 1.6;
export const DEMO_SCORE_FIBER_CAP = 8;
/** カロリーの点 = kcal が DEMO_SCORE_KCAL_RANGE_MIN〜DEMO_SCORE_KCAL_RANGE_MAX なら DEMO_SCORE_KCAL_IN_RANGE、外なら DEMO_SCORE_KCAL_OUT_OF_RANGE */
export const DEMO_SCORE_KCAL_RANGE_MIN = 250;
export const DEMO_SCORE_KCAL_RANGE_MAX = 900;
export const DEMO_SCORE_KCAL_IN_RANGE = 5;
export const DEMO_SCORE_KCAL_OUT_OF_RANGE = 2;

/**
 * デモの写真の名前の最大の字数。320 px の画面で写真のボタンは 74 px ほど (結果のカードの内側 240 px から間 0.5rem × 2 を引いて 3 等分)、
 * 枠 2 px × 2 と帯の左右の余白 0.25rem × 2 を引くと 62 px で、14 px の字が 4 字まで 1 行に入る (docs/design/marketing/01-landing-site.md §8.3)
 */
export const DEMO_PHOTO_NAME_MAX_CHARS = 4;

/** デモの推定の栄養 (サンプル)。表示の順は DEMO_NUTRITION_KEYS */
export const DemoNutritionSchema = z.object({
  kcal: z.number().int().min(0),
  proteinG: z.number().int().min(0),
  carbsG: z.number().int().min(0),
  fatG: z.number().int().min(0),
  fiberG: z.number().int().min(0),
});

/** デモの見本 (AI は呼ばない。スコアは demoScore、記録コメントは demoPraiseComment が作る) */
export const DemoSampleSchema = z.object({
  id: z.enum(['salad-bowl', 'salmon-plate', 'pesto-pasta']),
  /** 写真の帯と結果に出す名前 (DEMO_PHOTO_NAME_MAX_CHARS 字まで。写真の帯の中で 1 行に収まる長さ) */
  name: z.string().min(1).max(DEMO_PHOTO_NAME_MAX_CHARS),
  photo: LandingImageSchema,
  /** AI が認識した料理の名前のサンプル (写真に写っているものだけ。先頭から DEMO_PRAISE_MAX_DISHES 個まで) */
  dishNames: z.array(z.string().min(1)).min(1).max(DEMO_PRAISE_MAX_DISHES),
  mealTypeLabel: z.enum(DEMO_MEAL_TYPE_LABELS),
  nutrition: DemoNutritionSchema,
});

const NutritionTextSchema = z.object({
  kcal: z.string().min(1),
  proteinG: z.string().min(1),
  carbsG: z.string().min(1),
  fatG: z.string().min(1),
  fiberG: z.string().min(1),
});

export const FeatureCardSchema = z.object({
  /** カードの id。画像の無いカードのアイコンの鍵を兼ねる */
  id: z.enum(['photo', 'praise', 'menu', 'shopping', 'health', 'badges', 'fridge', 'family']),
  size: z.enum(['large', 'medium', 'small']),
  title: z.string().min(1),
  body: z.string().min(1),
  image: LandingImageSchema.nullable(),
  claimId: z.enum(CLAIM_IDS),
});

/**
 * badges テーブルの行と同じ code / name。description は紹介ページの文で、付与の条件をそのまま言う (DB の説明は写さない)。
 * photo_10・planner は、名前が付与の条件と食い違うので載せない (docs/design/marketing/01-landing-site.md §4.6)
 */
export const BadgeCardSchema = z.object({
  code: z.enum(['first_bite', 'streak_3', 'streak_7', 'tutorial_complete']),
  name: z.string().min(1),
  description: z.string().min(1),
});

export const FaqItemSchema = z.object({ q: z.string().min(1), a: z.string().min(1) });
export const TrustItemSchema = z.object({ title: z.string().min(1), body: z.string().min(1), link: LandingLinkSchema.nullable() });
export const StepSchema = z.object({ title: z.string().min(1), body: z.string().min(1), image: LandingImageSchema });

export const LandingCopySchema = z.object({
  header: z.object({ nav: z.array(LandingLinkSchema).length(4), login: LandingLinkSchema, cta: LandingLinkSchema }),
  hero: z.object({
    eyebrow: z.string().min(1),
    headlineLines: z.array(z.string().min(1)).length(2),
    lead: z.string().min(1),
    primaryCta: LandingLinkSchema,
    secondaryCta: LandingLinkSchema,
    assurances: z.array(z.string().min(1)).length(3),
    /** 扇に重ねる実際の画面 3 枚。順は HTML の順 (読み上げの順) で、左の後ろ・右の後ろ・前の中央 */
    screens: z.array(LandingImageSchema).length(3),
    screensCaption: z.string().min(1),
  }),
  how: z.object({ title: z.string().min(1), lead: z.string().min(1), steps: z.array(StepSchema).length(3), screensCaption: z.string().min(1) }),
  demo: z.object({
    eyebrow: z.string().min(1),
    title: z.string().min(1),
    lead: z.string().min(1),
    pickerTitle: z.string().min(1),
    analyzingTitle: z.string().min(1),
    analyzingBody: z.string().min(1),
    scoreNote: z.string().min(1),
    resultTitle: z.string().min(1),
    nutritionTitle: z.string().min(1),
    nutritionLabels: NutritionTextSchema,
    nutritionUnits: NutritionTextSchema,
    sampleNotice: z.string().min(1),
    emptyBody: z.string().min(1),
    cta: LandingLinkSchema,
    samples: z.array(DemoSampleSchema).length(3),
  }),
  features: z.object({ title: z.string().min(1), lead: z.string().min(1), cards: z.array(FeatureCardSchema).length(8), screensCaption: z.string().min(1) }),
  badges: z.object({ title: z.string().min(1), lead: z.string().min(1), items: z.array(BadgeCardSchema).length(4) }),
  trust: z.object({ title: z.string().min(1), items: z.array(TrustItemSchema).length(4) }),
  faq: z.object({ title: z.string().min(1), lead: z.string().min(1), items: z.array(FaqItemSchema).length(6), contactLead: z.string().min(1), contact: LandingLinkSchema }),
  finalCta: z.object({ title: z.string().min(1), lead: z.string().min(1), cta: LandingLinkSchema, assurances: z.array(z.string().min(1)).length(3), disclaimer: z.string().min(1) }),
  footer: z.object({
    tagline: z.string().min(1),
    columns: z.array(z.object({ title: z.string().min(1), links: z.array(LandingLinkSchema).min(1) })).length(3),
    socialLinks: z.array(LandingLinkSchema),
    storeLinks: z.array(LandingLinkSchema),
    copyrightYear: z.number().int().min(2025),
  }),
  claims: z.array(LandingClaimSchema).length(CLAIM_IDS.length),
});

export type LandingCopy = z.infer<typeof LandingCopySchema>;
export type LandingClaim = z.infer<typeof LandingClaimSchema>;
export type ClaimId = (typeof CLAIM_IDS)[number];
export type DemoSample = z.infer<typeof DemoSampleSchema>;
export type DemoSampleId = DemoSample['id'];
export type DemoNutrition = z.infer<typeof DemoNutritionSchema>;
export type DemoNutritionKey = keyof DemoNutrition;
export type FeatureCard = z.infer<typeof FeatureCardSchema>;
export type FeatureCardId = FeatureCard['id'];
export type BadgeCard = z.infer<typeof BadgeCardSchema>;

/** デモの栄養の表示の順 (アプリの結果の画面の カロリー・タンパク質・炭水化物・脂質 の順に、スコアの式が使う食物繊維を続ける。§4.5) */
export const DEMO_NUTRITION_KEYS: readonly DemoNutritionKey[] = ['kcal', 'proteinG', 'carbsG', 'fatG', 'fiberG'];

// ─── 動き・レイアウト・画像の定数 (根拠は docs/design/marketing/01-landing-site.md §5・§6) ───
/** デモの「分析中」の長さ (ms)。AI の実際の応答より短く、進捗の棒が読める長さ (M-7) */
export const DEMO_ANALYZING_MS = 1400;
/** 動きを減らす設定のときのデモの待ち時間 (ms。結果をすぐ出す) */
export const DEMO_ANALYZING_MS_REDUCED = 0;
/** ヘッダーに背景を付けるスクロール量 (px。M-1) */
export const HEADER_SCROLLED_PX = 24;
/**
 * 現れ方 (M-5): 要素のどこか 1 px でも、画面の下の 10 % を除いた範囲に入ったら (IntersectionObserver の rootMargin。threshold は 0)。
 * 要素の何割が見えたか (threshold の割合) では決めない: 割合は「画面の高さ ÷ 要素の高さ」を超えないので、高い要素が隠れたままになる (§6.3)
 */
export const REVEAL_ROOT_MARGIN = '0px 0px -10% 0px';
/** 現れ方の子の遅れ (ms。marketing.css の --lp-stagger と同じ) と、遅らせる最大の個数 */
export const REVEAL_STAGGER_MS = 40;
export const REVEAL_STAGGER_MAX = 6;
/** デモの結果の出入りの時間 (秒。framer-motion は秒で受ける)。marketing.css の --lp-dur (320ms) と同じ (M-7) */
export const DEMO_MOTION_DURATION_S = 0.32;
/** デモの出入りの緩急。marketing.css の --lp-ease (cubic-bezier(0.2, 0.8, 0.2, 1)) と同じ */
export const DEMO_MOTION_EASE = [0.2, 0.8, 0.2, 1] as const;
/** デモの結果のパネルが下から上がる距離 (px。M-7) */
export const DEMO_RESULT_OFFSET_PX = 8;
/** / の viewport の maximum-scale。Lighthouse の meta-viewport の監査は 5 未満を不合格にする (WCAG 1.4.4 の拡大)。ルートの layout の 1 を / だけ上書きする (§9.3) */
export const LANDING_VIEWPORT_MAXIMUM_SCALE = 5;
/** next/image の sizes (§5.4 の表。表示の幅に合わせて読む画像の大きさを決める) */
export const LANDING_IMAGE_SIZES = {
  heroFront: '(max-width: 639px) 58vw, 260px',
  heroBack: '(max-width: 639px) 46vw, 208px',
  step: '208px',
  feature: '(max-width: 767px) 50vw, 208px',
  demoPhoto: '(max-width: 767px) 30vw, 160px',
} as const;
/** 著作権表示の年 (日付の計算はしない。年が変わったらここを直す) */
export const COPYRIGHT_YEAR = 2026;
/** 新規登録と、デモのアンカー */
export const SIGNUP_HREF = '/signup';
export const DEMO_ANCHOR = '#demo';

const ASSURANCES: [string, string, string] = ['いまは無料で使えます', 'クレジットカード不要', 'いつでも退会できます'];
/** 実際の画面 (public/guide/*.png) を出すセクション (ヒーロー・使い方・機能) の注記。画面は本物のアプリで、記録と数値は撮影用の見本 (docs/design/marketing/01-landing-site.md §7.1) */
export const SCREENS_CAPTION = '実際のアプリの画面です。表示している記録と数値は、撮影用の見本です。';
const PRIMARY_CTA = { label: '無料で始める', href: SIGNUP_HREF };

export const LANDING_COPY = {
  header: {
    nav: [
      { label: '機能', href: '#features' },
      { label: '使い方', href: '#how' },
      { label: 'バッジ', href: '#badges' },
      { label: 'よくある質問', href: '#faq' },
    ],
    login: { label: 'ログイン', href: '/login' },
    cta: PRIMARY_CTA,
  },
  hero: {
    eyebrow: '褒めて伸ばす、AI 食事記録アプリ',
    headlineLines: ['食べることを、', 'もっと誇らしく。'],
    lead: '写真を撮るだけ。AI が料理を認識して、栄養を推定します。食事の記録の画面では、写真で記録すると、ほめるひと言と栄養のひと言メモが出ます。',
    primaryCta: PRIMARY_CTA,
    secondaryCta: { label: 'デモを試す', href: DEMO_ANCHOR },
    assurances: ASSURANCES,
    screens: [
      { src: '/guide/camera.png', alt: '食事の写真を選んだ撮影の画面' },
      { src: '/guide/analyze.png', alt: '食事の写真の解析結果の画面' },
      { src: '/guide/comment.png', alt: '解析結果の記録コメント' },
    ],
    screensCaption: SCREENS_CAPTION,
  },
  how: {
    title: '使い方は、3 つだけ。',
    lead: '難しい設定はありません。今日から始められます。',
    steps: [
      { title: '写真を撮る', body: '食事の写真を撮るか、選ぶだけ。カロリーの入力も、食材の選択もいりません。', image: { src: '/guide/camera.png', alt: '食事の写真を選んだ撮影の画面' } },
      { title: 'AI が見る', body: 'AI が料理を認識して、カロリー・タンパク質・野菜のバランスを推定します。数値はあくまで推定です。', image: { src: '/guide/analyze.png', alt: '食事の写真の解析結果の画面' } },
      { title: '褒められる', body: '食事の記録の画面に、記録をほめるひと言が出ます。献立の振り返りでは、AI が良いところを見つけて言葉にします。', image: { src: '/guide/comment.png', alt: '解析結果の記録コメント' } },
    ],
    screensCaption: SCREENS_CAPTION,
  },
  demo: {
    eyebrow: '試してみる',
    title: '褒められるって、こういうこと。',
    lead: '写真を 1 枚選ぶと、写真の解析の結果のサンプル（スコア・記録コメント・推定の栄養）が出ます。',
    pickerTitle: '食事の写真を選ぶ',
    analyzingTitle: 'AI が見ています…',
    analyzingBody: '料理を認識して、栄養を推定しています',
    scoreNote: 'スコアは、アプリと同じ計算で、タンパク質・食物繊維・カロリーの推定から出しています。',
    resultTitle: '記録コメント',
    nutritionTitle: '推定の栄養',
    nutritionLabels: { kcal: 'カロリー', proteinG: 'タンパク質', carbsG: '炭水化物', fatG: '脂質', fiberG: '食物繊維' },
    nutritionUnits: { kcal: 'kcal', proteinG: 'g', carbsG: 'g', fatG: 'g', fiberG: 'g' },
    sampleNotice: '表示はサンプルです。実際のアプリでは、写真から AI が認識した料理の名前が入り、数値は推定です。',
    emptyBody: '写真を選ぶと、ここにスコアと記録コメントが出ます。',
    cta: { label: '自分の食事で試す', href: SIGNUP_HREF },
    samples: [
      {
        id: 'salad-bowl',
        name: 'サラダ',
        photo: { src: '/marketing/photos/salad-bowl.webp', alt: '葉野菜とアボカドとミニトマトとひよこ豆のサラダボウル' },
        dishNames: ['サラダボウル'],
        mealTypeLabel: '昼食',
        nutrition: { kcal: 380, proteinG: 12, carbsG: 28, fatG: 22, fiberG: 10 },
      },
      {
        id: 'salmon-plate',
        name: 'サーモン',
        photo: { src: '/marketing/photos/salmon-plate.webp', alt: '焼いたサーモンといんげんとミニトマトを盛り合わせたプレート' },
        dishNames: ['焼きサーモン', 'いんげんとミニトマト'],
        mealTypeLabel: '夕食',
        nutrition: { kcal: 480, proteinG: 30, carbsG: 40, fatG: 20, fiberG: 4 },
      },
      {
        id: 'pesto-pasta',
        name: 'パスタ',
        photo: { src: '/marketing/photos/pesto-pasta.webp', alt: 'バジルソースのファルファッレとミニトマトと葉野菜' },
        dishNames: ['バジルソースのパスタ'],
        mealTypeLabel: '昼食',
        nutrition: { kcal: 610, proteinG: 17, carbsG: 74, fatG: 26, fiberG: 3 },
      },
    ],
  },
  features: {
    title: '写真の記録だけじゃない。',
    lead: '献立から買い物、体重や健康診断の記録まで。ひとつのアプリでそろいます。',
    cards: [
      { id: 'photo', size: 'large', title: '写真で記録', body: '撮るだけで、AI が料理を認識して栄養を推定します。面倒な入力はいりません。', image: { src: '/guide/analyze.png', alt: '食事の写真の解析結果の画面' }, claimId: 'photo-analyze' },
      { id: 'praise', size: 'large', title: 'ほめるひと言', body: '食事の記録の画面では、写真で記録すると、ほめるひと言と「栄養メモ」が出ます。献立の振り返りでは、AI が良いところを見つけて言葉にします。', image: { src: '/guide/comment.png', alt: '解析結果の記録コメント' }, claimId: 'praise' },
      { id: 'menu', size: 'medium', title: '1週間の献立を AI が提案', body: '「今日なに作ろう」を、AI 献立アシスタントが引き受けます。冷蔵庫優先・時短中心・和食多めなどの条件も選べます。', image: { src: '/guide/menu-result.png', alt: '1 週間分の献立が入った献立表' }, claimId: 'weekly-menu' },
      { id: 'shopping', size: 'medium', title: '買い物リスト', body: '献立から買い物リストを作ります。スーパーで迷いません。', image: null, claimId: 'shopping-list' },
      { id: 'health', size: 'medium', title: '体重と健康の記録', body: '体重は体重計の写真からも記録できます。推移はグラフで。健康診断の結果も写真から取り込めます。', image: { src: '/guide/weight.png', alt: '体重を入力する画面' }, claimId: 'health-records' },
      { id: 'badges', size: 'medium', title: 'バッジを集める', body: '食べた食事を「完了」にしていくと、バッジが増えていきます。', image: { src: '/guide/badge-collection.png', alt: 'トロフィールームのバッジの一覧' }, claimId: 'badges' },
      { id: 'fridge', size: 'small', title: '冷蔵庫の写真から食材を読み取り', body: '冷蔵庫を撮ると、食材を読み取って献立の材料にします。', image: null, claimId: 'fridge' },
      { id: 'family', size: 'small', title: '家族で使える', body: '家族を招待して、献立を一緒に見たり、記録を共有したりできます。', image: null, claimId: 'family' },
    ],
    screensCaption: SCREENS_CAPTION,
  },
  badges: {
    title: '集めたくなる、あなたの勲章。',
    lead: '食べた食事を「完了」にした回数や、続けた日数で、バッジが増えていきます。',
    items: [
      { code: 'first_bite', name: 'はじめの一歩', description: 'はじめて食事を「完了」にすると付きます。' },
      { code: 'streak_3', name: '三日坊主卒業', description: '3日続けて、食事を「完了」にすると付きます。' },
      { code: 'streak_7', name: '週間チャンピオン', description: '1週間続けて、食事を「完了」にすると付きます。' },
      { code: 'tutorial_complete', name: '使い方マスター', description: 'アプリの中の使い方の案内を、最後まで終えると付きます。' },
    ],
  },
  trust: {
    title: '正直に、お伝えします。',
    items: [
      { title: 'いまは無料で使えます', body: '現在ご提供している機能は、すべて無料です。AI を使う機能には、1 日にご利用いただける回数の上限があります。有料プランは準備中です（販売開始前）。内容や料金が決まりましたらご案内します。', link: null },
      { title: 'データの取り扱い', body: 'AI を使う機能は、日本国外の AI 事業者へのデータ提供について同意をいただいてから使えます。写真や記録の保存と第三者への提供については、プライバシーポリシーをご確認ください。', link: { label: 'プライバシーポリシーを読む', href: '/privacy' } },
      { title: 'AI の分析は推定です', body: '料理や撮影の条件によって、実際の値と異なることがあります。医療目的での使用はお控えください。', link: null },
      { title: '退会と書き出し', body: '設定からいつでも退会できます。記録したデータは JSON 形式で書き出せます。', link: null },
    ],
  },
  faq: {
    title: 'よくある質問',
    lead: '気になることがあれば、ここで。',
    items: [
      { q: '本当に無料で使えますか？', a: 'はい。現在ご提供している機能は、写真の記録、ほめるひと言、献立の提案、健康の記録など、すべて無料でお使いいただけます。AI を使う機能（写真の解析や献立の提案など）は、1 日にご利用いただける回数に上限があり、上限に達した日は翌日 0 時からまたお使いいただけます。有料プランは準備中です（販売開始前）。内容や料金が決まりましたらご案内します。' },
      { q: 'どんな写真を撮ればいいですか？', a: '食事全体が写っていれば大丈夫です。真上からでも斜めからでも構いません。明るい場所で撮ると、料理を認識しやすくなります。' },
      // データの取り扱いの最終的な文言は、プライバシーポリシーの見直しと合わせて決める。それまでは断定せず、プライバシーポリシーへ案内する (tests/public-claims-guard.test.ts がこの行を見る)
      { q: "データは安全ですか？", a: 'データの取り扱い（保存や第三者への提供など）については、プライバシーポリシーをご確認ください。いつでもデータの削除をリクエストできます。' },
      { q: '家族で使えますか？', a: 'はい。家族を招待して、献立を一緒に見たり、記録を共有したりできます。' },
      { q: 'AI の分析は正確ですか？', a: 'AI による分析はあくまで推定値で、料理や撮影条件によっては実際の値と異なる場合があります。医療目的での使用はお控えください。日々の食生活の参考としてお使いください。' },
      { q: '退会やデータの削除はできますか？', a: 'はい。設定からいつでも退会できます。記録したデータは、退会の前に JSON 形式で書き出せます。' },
    ],
    contactLead: 'ほかに質問がある場合は',
    contact: { label: 'お問い合わせフォームへ', href: '/contact' },
  },
  finalCta: {
    title: '明日の食事が、楽しみになる。',
    lead: 'まずは 3 日、写真で記録してみてください。食事の記録の画面に、記録をほめるひと言が出ます。',
    cta: PRIMARY_CTA,
    assurances: ASSURANCES,
    disclaimer: 'AI の分析は推定値です。医療上の判断には使わず、気になることは医師にご相談ください。',
  },
  footer: {
    tagline: '写真を撮るだけで、AI が料理を認識して、記録をほめてくれる食事記録アプリ。',
    columns: [
      { title: 'サービス', links: [{ label: 'サービスについて', href: '/about' }, { label: '新規登録', href: SIGNUP_HREF }, { label: 'ログイン', href: '/login' }, { label: '料金プラン', href: '/pricing' }] },
      { title: 'サポート', links: [{ label: '使い方ガイド', href: '/guide' }, { label: 'お問い合わせ', href: '/contact' }, { label: 'よくある質問', href: '/faq' }, { label: 'お知らせ', href: '/news' }] },
      { title: '法的情報', links: [{ label: '利用規約', href: '/terms' }, { label: 'プライバシーポリシー', href: '/privacy' }, { label: '特定商取引法に基づく表記', href: '/legal' }, { label: '運営会社', href: '/company' }] },
    ],
    socialLinks: [],
    storeLinks: [],
    copyrightYear: COPYRIGHT_YEAR,
  },
  claims: [
    {
      id: 'photo-analyze',
      text: '写真を撮るだけで、AI が料理を認識して栄養を推定する',
      evidence: ['src/app/api/ai/analyze-meal-photo/route.ts', 'src/app/(main)/meals/new/page.tsx', 'supabase/functions/_shared/nutrition-pipeline.ts'],
      condition: 'データ提供への同意 (ai-consent) と 1 日の利用回数の上限 (ai-daily-limit) の範囲で使える。数値は推定 (ai-estimate)',
    },
    {
      id: 'praise',
      text: '食事の記録の画面では、写真で記録すると、記録をほめるひと言 (記録コメント) が出る。献立の振り返りでは、AI が良い点を見つけて褒める',
      evidence: ['supabase/functions/_shared/nutrition-pipeline.ts', 'supabase/functions/analyze-meal-photo/index.ts', 'src/app/(main)/meals/new/page.tsx', 'src/app/api/ai/nutrition/feedback/route.ts', 'src/app/(main)/menus/weekly/page.tsx'],
      condition: '記録コメントは料理の名前と食事の区分だけが変わる定型の文。記録のときの画面に出すのは食事の記録の画面だけで、献立表の写真から入力では出さず、写真を使わない記録では作らない。同意と 1 日の利用回数の上限の範囲で',
    },
    {
      id: 'nutrition-tip',
      text: '食事の記録の画面では、写真で記録すると、栄養のひと言のメモ (栄養メモ) が出る',
      evidence: ['supabase/functions/_shared/nutrition-pipeline.ts', 'src/app/(main)/meals/new/page.tsx'],
      condition: '献立表の写真から入力では保存も表示もしない。同意と 1 日の利用回数の上限の範囲で',
    },
    {
      id: 'demo-sample',
      text: 'デモの結果はサンプル。スコアと記録コメントは、アプリの写真の解析と同じ式と同じ定型の文で、表示する推定の値と料理の名前から作る',
      evidence: ['supabase/functions/_shared/nutrition-pipeline.ts'],
      condition: 'サンプルの値は実際の解析の値ではない。アプリの結果の画面の栄養の 5 つ目は野菜の点で、デモはスコアを再計算できるよう食物繊維を出す',
    },
    {
      id: 'weekly-menu',
      text: '1週間の献立を AI が提案する (条件: 冷蔵庫優先・時短中心・和食多め)',
      evidence: ['src/app/(main)/menus/weekly/page.tsx', 'src/app/api/ai/menu/weekly/request/route.ts', 'src/components/ai-assistant/V4GenerateModal.tsx'],
      condition: '同意と 1 日の利用回数の上限の範囲で',
    },
    {
      id: 'shopping-list',
      text: '献立から買い物リストを作る',
      evidence: ['src/app/api/shopping-list/', 'tests/regenerate-shopping-list-request-ownership.test.ts'],
      condition: 'AI での作り直しは 1 日の利用回数の上限に数える',
    },
    {
      id: 'health-records',
      text: '体重 (体重計の写真からも) と健康診断の結果 (写真から) を記録し、推移をグラフで見る',
      evidence: ['src/app/api/ai/analyze-weight-scale/route.ts', 'src/app/api/ai/analyze-health-checkup/route.ts', 'src/app/api/health/checkups/route.ts', 'src/app/(main)/health/'],
      condition: '写真の読み取りは同意と 1 日の利用回数の上限の範囲で',
    },
    {
      id: 'badges',
      text: '食べた食事を「完了」にした回数と続けた日数、アプリの中の使い方の案内の完走で、バッジが付く',
      evidence: ['src/app/api/badges/route.ts', 'src/lib/badges/awardable.ts', 'src/lib/jst-day-ranges.ts', 'supabase/migrations/20251126124224_create_meal_planner_tables.sql', 'src/app/api/meal-plans/add-from-photo/route.ts'],
      condition: '数えるのは完了にした食事 (使い方の練習のお試しの記録を除く) と、完了した食事のある日の連続日数。写真から献立表に保存しただけの食事は、完了にするまで数えない。photo_10 と planner は、名前が付与の条件と食い違うので載せない',
    },
    {
      id: 'fridge',
      text: '冷蔵庫の写真から食材を読み取る',
      evidence: ['src/app/api/ai/analyze-fridge/route.ts', 'src/app/(main)/pantry/'],
      condition: '同意と 1 日の利用回数の上限の範囲で',
    },
    {
      id: 'family',
      text: '家族を招待して献立を一緒に見る・記録を共有する',
      evidence: ['src/app/api/family/groups/route.ts', 'src/app/api/family/invites/route.ts', 'src/app/api/family/members/me/share/route.ts', 'src/app/(main)/family/'],
      condition: null,
    },
    {
      id: 'free-now',
      text: 'いまは無料で使える・有料プランは準備中',
      evidence: ['src/app/pricing/PricingPageView.tsx'],
      condition: 'AI を使う機能には 1 日の利用回数の上限がある。無料と書く段落には上限の文も入れる',
    },
    {
      id: 'ai-daily-limit',
      text: 'AI を使う機能 (写真の解析や献立の提案など) は、1 日に使える回数に上限がある。上限に達した日は、翌日 0 時から使える',
      evidence: ['src/lib/plan/entitlements.ts', 'supabase/functions/_shared/ai-daily-limit.ts', 'supabase/functions/_shared/ai-usage-core.ts', 'supabase/migrations/20261011020000_ai_daily_limits.sql'],
      condition: '回数の数字は書かない (運営画面で変えられる。既定は free の 10 回)。上限に数えない自動の機能もある',
    },
    {
      id: 'ai-consent',
      text: 'AI を使う機能は、日本国外の AI 事業者へのデータ提供について同意を受けてから使える',
      evidence: ['src/components/consent/AiDataConsentModal.tsx', 'src/lib/ai/consent-guard.ts', 'src/lib/ai/consent-config.ts'],
      condition: null,
    },
    {
      id: 'no-card',
      text: 'クレジットカード不要',
      evidence: ['src/app/(auth)/signup/'],
      condition: null,
    },
    {
      id: 'delete-export',
      text: 'いつでも退会できる・データを JSON で書き出せる',
      evidence: ['src/app/api/account/', 'tests/account-delete-route.test.ts', 'tests/account-export.test.ts'],
      condition: null,
    },
    {
      id: 'ai-estimate',
      text: 'AI の分析は推定で、医療目的に使わない',
      evidence: ['src/app/faq/page.tsx'],
      condition: null,
    },
    {
      id: 'privacy',
      text: 'データの取り扱いはプライバシーポリシーに書く',
      evidence: ['src/app/privacy/page.tsx'],
      condition: '保存と第三者への提供は断定せず、プライバシーポリシーへ案内する',
    },
  ],
} satisfies LandingCopy;

/** サービスの名前 (ヘッダー・フッター)。直接書かず site-config から (JSON-LD は SiteStructuredData が site-config から直接読む) */
export const LANDING_SITE_NAME = SITE_NAME;

/** 主張の一覧 (テストから読む) */
export function landingClaims(copy: LandingCopy = LANDING_COPY): readonly LandingClaim[] {
  return copy.claims;
}

/** ページが指す public/ の画像のパス (出てくる順・重複なし) */
export function landingImagePaths(copy: LandingCopy = LANDING_COPY): string[] {
  const paths = [
    ...copy.hero.screens.map((image) => image.src),
    ...copy.how.steps.map((step) => step.image.src),
    ...copy.demo.samples.map((sample) => sample.photo.src),
    ...copy.features.cards.flatMap((card) => (card.image ? [card.image.src] : [])),
  ];
  return [...new Set(paths)];
}

/**
 * デモの記録コメント。アプリの定型の文 (nutrition-pipeline.ts の buildTemplatePraiseAndTip) と同じ形:
 *   <料理の名前 (先頭 2 つを、でつなぐ)>の記録がしっかりできていて素晴らしいです。<食事の区分>を丁寧に残せていて、とても良い流れです。
 * 違いは文の終わりだけ (アプリは絵文字・紹介ページは句点)。料理の中身を褒める文は作らない (§4.5)
 */
export function demoPraiseComment(sample: Pick<DemoSample, 'dishNames' | 'mealTypeLabel'>): string {
  const dishes = sample.dishNames.slice(0, DEMO_PRAISE_MAX_DISHES).join(DEMO_PRAISE_DISH_SEPARATOR);
  return `${dishes}${DEMO_PRAISE_DISH_SUFFIX}${DEMO_PRAISE_RECORD_PHRASE}${sample.mealTypeLabel}${DEMO_PRAISE_MEAL_PHRASE}${DEMO_PRAISE_END}`;
}

/**
 * デモのスコア。アプリの overallScore と同じ式・同じ足し算の順 (nutrition-pipeline.ts :762-765)。
 * 表示するタンパク質・食物繊維・カロリーだけで決まるので、読者が隣の値から再計算できる (§4.5)
 */
export function demoScore(nutrition: Pick<DemoNutrition, 'kcal' | 'proteinG' | 'fiberG'>): number {
  const proteinScore = Math.min(DEMO_SCORE_PROTEIN_CAP, nutrition.proteinG / DEMO_SCORE_PROTEIN_DIVISOR);
  const fiberScore = Math.min(DEMO_SCORE_FIBER_CAP, nutrition.fiberG * DEMO_SCORE_FIBER_FACTOR);
  const caloriesScore =
    nutrition.kcal >= DEMO_SCORE_KCAL_RANGE_MIN && nutrition.kcal <= DEMO_SCORE_KCAL_RANGE_MAX ? DEMO_SCORE_KCAL_IN_RANGE : DEMO_SCORE_KCAL_OUT_OF_RANGE;
  return Math.max(DEMO_SCORE_MIN, Math.min(DEMO_SCORE_MAX, Math.round(DEMO_SCORE_BASE + proteinScore + fiberScore + caloriesScore)));
}
