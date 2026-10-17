/**
 * /legal のメタ情報 (#1867)。page.tsx は 'use client' で metadata を export できないので、この layout が持つ
 * (title・description・canonical・OGP。中身は src/lib/seo/public-pages.ts)。画面には何も足さない。
 * 配下のページ (/legal/parental-consent) にも引き継がれるので、配下のページは自分の page で publicPageMetadata を呼ぶ
 * (呼ばないと canonical が /legal になる。tests/seo-public-pages-1867.test.ts が配下の page を検査する)。
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { publicPageMetadata } from '@/lib/seo/public-pages';

export const metadata: Metadata = publicPageMetadata('/legal');

export default function LegalLayout({ children }: { children: ReactNode }) {
  return children;
}
