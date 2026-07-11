// src/app/(main)/menus/weekly/_components/colors.ts
// #1050 レビュー残ポリッシュ (Opus 再レビュー Warning): weekly page.tsx の配色定義が
// GenerationResultDialogContent.tsx に独自コピーされ、3値（success/successLight/border）が
// 正本の page.tsx と乖離していた（成功モーダルの見た目が緑チェックの色から意図せず
// 変わっていた）。両者が参照する唯一の正本としてこのモジュールを新設し、二重定義を解消する。
//
// 依存ゼロの定数のみのモジュールにしているのは、GenerationResultDialogContent.tsx が
// page.tsx 本体（supabase client 等の重い依存を大量に import する）を経由せずに
// 単体でテストできる状態を維持するため。
export const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#E5A84B',
  warningLight: '#FEF9EE',
  purple: '#7C6BA0',
  purpleLight: '#F5F3F8',
  blue: '#5B8BC7',
  blueLight: '#EEF4FB',
  border: '#E8E8E8',
  danger: '#D64545',
  dangerLight: '#FDECEC',
} as const;
