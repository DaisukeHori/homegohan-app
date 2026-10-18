// 動きを減らす設定の判定 (docs/design/marketing/01-landing-site.md §6.4)。
// ハンズオンツアーの既存の hook (matchMedia('(prefers-reduced-motion: reduce)') を監視) を再 export する。
// 紹介ページがツアーの部品を直接 import しないための入れ替え口 (将来 src/hooks/ へ移すときはここだけ直す)。
// 初回の描画は false (サーバーと同じ)。デモの待ち時間は押したときに読む (描画時に固定しない)。
export { useReducedMotion } from '@/components/handson-tour/useReducedMotion';
