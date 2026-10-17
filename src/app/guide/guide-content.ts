/**
 * 使い方ガイド (/guide) の中身: 章・手順の文と、手順ごとの画面の画像 (#1852)。
 *
 * 画像は public/guide/<名前>.png に置く。ローカルの組み立て (ローカルの Supabase + 本番ビルド + テスト用のデータ) で
 * scripts/guide-screenshots/ の台本が撮影する。撮り直すときの手順は scripts/guide-screenshots/run.sh の先頭のコメント。
 * ここに書いたパスがすべて public に実在すること・大きさと重さは tests/guide-images-1852.test.ts が確かめる。
 *
 * 説明の文は、撮影した画面の文言 (ボタンの名前など) と合わせる。画面の文言を変えたら、ここと画像も見直す。
 */
import { Camera, ChefHat, Scale, Smartphone, Trophy, type LucideIcon } from 'lucide-react';

/** ガイドの画像のパスの形 (public/guide の直下の PNG) */
export type GuideImagePath = `/guide/${string}.png`;

export interface GuideStep {
  title: string;
  desc: string;
  image: GuideImagePath;
  /** 画像の代替テキスト (何の画面か) */
  imageAlt: string;
}

export interface Guide {
  id: string;
  title: string;
  Icon: LucideIcon;
  color: string;
  steps: readonly GuideStep[];
}

/**
 * 画像の大きさ (px)。撮影はスマートフォンの画面 (幅 390 の縦長) で行い、この大きさに縮めて保存する。
 * ページは縦長のまま枠の高さ (GUIDE_IMAGE_DISPLAY_MAX_HEIGHT_PX) に収めて表示する。
 * 表示の幅 (約 260px) の 2 倍ほどにして、高解像度の画面でもぼやけないようにしてある
 */
export const GUIDE_IMAGE_SIZE = { width: 540, height: 1080 } as const;

/** ページで画像を表示する高さの上限 (CSS px) */
export const GUIDE_IMAGE_DISPLAY_MAX_HEIGHT_PX = 520;

export const GUIDE_COLORS = {
  primary: '#E07A5F',
  success: '#6B9B6B',
  warning: '#F4A261',
  secondary: '#3D5A80',
  badge: '#FFD700',
} as const;

export const GUIDES: readonly Guide[] = [
  {
    id: 'start',
    title: '🚀 はじめかた',
    Icon: Smartphone,
    color: GUIDE_COLORS.primary,
    steps: [
      { title: 'アカウント作成', desc: 'メールアドレスまたはGoogleアカウントで30秒で登録完了。', image: '/guide/signup.png', imageAlt: '新規登録の画面' },
      { title: 'プロフィール設定', desc: '身長・体重・目標を入力。AIがあなたに最適な提案をするために必要です。', image: '/guide/profile.png', imageAlt: '身長と体重を入力する画面' },
      { title: '準備完了！', desc: 'これで準備OK！さっそく食事を記録してみましょう。', image: '/guide/ready.png', imageAlt: '設定が完了した画面' },
    ],
  },
  {
    id: 'record',
    title: '📸 食事を記録する',
    Icon: Camera,
    color: GUIDE_COLORS.success,
    steps: [
      { title: '写真を撮る', desc: 'ホーム画面のカメラボタンをタップ。食事全体が写るように撮影します。', image: '/guide/camera.png', imageAlt: '食事の写真を選んだ撮影の画面' },
      { title: 'AI分析を待つ', desc: '数秒でAIが料理を認識。カロリー、タンパク質、野菜スコアを自動計算。', image: '/guide/analyze.png', imageAlt: '食事の写真の解析結果の画面' },
      { title: 'コメントをもらう', desc: 'AIがあなたの食事の良いところを見つけて褒めてくれます！', image: '/guide/comment.png', imageAlt: '解析結果の記録コメント' },
    ],
  },
  {
    id: 'menu',
    title: '🍽️ 献立を提案してもらう',
    Icon: ChefHat,
    color: GUIDE_COLORS.warning,
    steps: [
      { title: '献立リクエスト', desc: '献立表の画面で「AI献立アシスタント」(空欄があるときは「AIに埋めてもらう」) をタップ。', image: '/guide/menu-request.png', imageAlt: '献立表の画面の AI 献立アシスタントのボタン' },
      { title: '条件を設定', desc: '作る範囲と、冷蔵庫優先・時短中心・和食多め・ヘルシーなどの条件を選べます（任意）。', image: '/guide/menu-setting.png', imageAlt: 'AI アシスタントで条件を選ぶ画面' },
      { title: '1週間分の献立', desc: 'AIが栄養バランスを考慮した1週間分の献立を自動生成！', image: '/guide/menu-result.png', imageAlt: '1 週間分の献立が入った献立表' },
    ],
  },
  {
    id: 'health',
    title: '💪 健康を記録する',
    Icon: Scale,
    color: GUIDE_COLORS.secondary,
    steps: [
      { title: '体重を記録', desc: '健康画面から体重を入力。グラフで推移を確認できます。', image: '/guide/weight.png', imageAlt: '体重を入力する画面' },
      { title: '写真で記録', desc: '健康画面の「写真で記録」から体重計を撮影すると、AIが数値を読み取ります。内容を確認してから記録できます。', image: '/guide/weight-photo.png', imageAlt: '体重計の読み取り結果を確認する画面' },
      { title: 'トレンドを確認', desc: '週間・月間のトレンドをグラフで確認。AIがアドバイスもくれます。', image: '/guide/trend.png', imageAlt: '体重の推移のグラフ' },
    ],
  },
  {
    id: 'badge',
    title: '🏆 バッジを集める',
    Icon: Trophy,
    color: GUIDE_COLORS.badge,
    steps: [
      { title: '目標を達成', desc: '毎日の記録や目標達成でバッジをゲット！', image: '/guide/badge-get.png', imageAlt: '新しいバッジを獲得したお知らせ' },
      { title: 'コレクション', desc: '獲得したバッジは、ホームの「獲得バッジ」から開くトロフィールームで確認できます。', image: '/guide/badge-collection.png', imageAlt: 'トロフィールームのバッジの一覧' },
      { title: 'レアバッジ', desc: '特別な条件を満たすとレアバッジが！全部集められるかな？', image: '/guide/badge-rare.png', imageAlt: 'レアバッジの詳細' },
    ],
  },
];

/** ガイドが指す画像のパスの一覧 (出てくる順・重複なし) */
export function guideImagePaths(guides: readonly Guide[] = GUIDES): GuideImagePath[] {
  return [...new Set(guides.flatMap((guide) => guide.steps.map((step) => step.image)))];
}
