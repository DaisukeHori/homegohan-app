/**
 * /contact のメタ情報 (#1867)。page.tsx は 'use client' で metadata を export できないので、この layout が持つ
 * (title・description・canonical・OGP。中身は src/lib/seo/public-pages.ts)。画面には何も足さない。
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { publicPageMetadata } from '@/lib/seo/public-pages';

export const metadata: Metadata = publicPageMetadata('/contact');

export default function ContactLayout({ children }: { children: ReactNode }) {
  return children;
}
