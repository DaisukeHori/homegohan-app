// Web版と同じカラーパレット (src/app/(main)/home/page.tsx L17-37)
export const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  accentDark: '#C4634C',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#E5A84B',
  warningLight: '#FEF9EE',
  error: '#F44336',
  errorLight: '#FFEBEE',
  danger: '#D64545',
  dangerLight: '#FDECEC',
  purple: '#7C6BA0',
  purpleLight: '#F5F3F8',
  blue: '#5B8BC7',
  blueLight: '#EEF4FB',
  border: '#E8E8E8',
  streak: '#FF6B35',
} as const;

export type ColorKey = keyof typeof colors;
