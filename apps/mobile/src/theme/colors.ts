import { STATUS_COLOR_TOKENS } from '@homegohan/shared';

// モバイルのカラーパレット
//
// 状態色 (success / warning / error / danger と各 Light、文字用の successText / warningText / dangerText) は、
// packages/shared の STATUS_COLOR_TOKENS が唯一の定義元 (#590)。Web の home・health・pantry も同じトークンを import する。
// 塗りの値は以前ここに直書きしていた値 (A 系) のままで、モバイルの見た目は変わらない。
// 塗りの色は白地で文字の AA (4.5:1) に届かないので、文字には successText / warningText / dangerText を使う。
//
// 中立色 (bg / card / text / border など) と accent / purple / blue はモバイル独自の値で、Web の画面ごとの値とは違う
// (例: Web の home は bg #FAF9F7・purple #7C4DFF)。Web と同じパレットではないので、揃えるのは別の変更で行う。
export const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  accentDark: '#C4634C',
  ...STATUS_COLOR_TOKENS,
  purple: '#7C6BA0',
  purpleLight: '#F5F3F8',
  blue: '#5B8BC7',
  blueLight: '#EEF4FB',
  border: '#E8E8E8',
  streak: '#FF6B35',
} as const;

export type ColorKey = keyof typeof colors;
