// Web版と同じカラーパレット (src/app/(main)/home/page.tsx L17-37)
export const colors = {
  bg: '#FFFFFF',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#666666',
  accent: '#FF8A65',
  accentLight: '#FFCCBC',
  accentDark: '#C4634C',
  success: '#4CAF50',
  successLight: '#E8F5E9',
  warning: '#FF9800',
  warningLight: '#FFF3E0',
  error: '#F44336',
  errorLight: '#FFEBEE',
  purple: '#7C4DFF',
  purpleLight: '#EDE7F6',
  blue: '#2196F3',
  blueLight: '#E3F2FD',
  border: '#EEEEEE',
  streak: '#FF6B35',
} as const;

export type ColorKey = keyof typeof colors;
