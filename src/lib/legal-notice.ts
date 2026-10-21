/**
 * 特定商取引法に基づく表記 (/legal。src/app/legal/page.tsx) の最終更新日 (日本時間 YYYY-MM-DD)。
 * ページは formatLegalEffectiveDate (@homegohan/shared) で「2026年10月22日」の形にして出す。日付をページに直接書かない。
 *
 * 表の行 (事業者の情報・販売の項目・販売価格) を変えたら、この日付も公開の日に変える。
 * tests/legal-notice-last-updated.test.ts が、表の中身の指紋 (描画した表の文字の SHA-256) とこの日付を組で固定しているので、
 * 表だけを変えて日付を変えないと赤になる (指紋と日付を一緒に直す)。
 *
 * 2026-10-22: 有料プランの販売の項目 (販売価格・支払方法など 9 行) の公開 (#1912 段 C・ba9f8492。2026-10-22 02:05 JST のマージ)
 */
export const LEGAL_NOTICE_LAST_UPDATED = '2026-10-22';
