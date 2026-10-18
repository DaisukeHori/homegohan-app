'use client';

// ページの中のリンクを押したら、移った先の区切りへフォーカスを移す hook
// (docs/design/marketing/01-landing-site.md §2.2・§8.3 の useInPageLinkFocus。SiteHeader が 1 回だけ呼ぶ)。
// ページの中のリンク (ナビ・「デモを試す」・機能のカード) は next/link の Link で描く。Link は既定の動作を止めて router で移り、
// 先の要素へスクロールするだけでフォーカスに触らないので、キーボードの人の「次の Tab の起点」が移らない。
// そこで document の click (Enter で押したリンクも click が出る) を受けて、先の section (tabindex="-1") に
// focus({ preventScroll: true }) する (スクロールは Link に任せる)。Link の onClick は React の根で先に動き、この listener はその後に動く。
// JS が無いときは listener も無いが、Link も素の a としてブラウザが移り、フォーカスの起点もブラウザが移す。
import { useEffect } from 'react';
import { inPageSectionId } from '../landing-copy';

/** マウスの左のボタン (MouseEvent.button の値。キーボードの Enter で出る click も 0) */
const PRIMARY_BUTTON = 0;
/** 紹介ページの根 (LandingPage の .lp)。この中のリンクだけを扱う */
const LANDING_ROOT_SELECTOR = '.lp';

export function useInPageLinkFocus(): void {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      // 修飾キーつき・中ボタンは、新しいタブなどブラウザの既定に任せる
      if (event.button !== PRIMARY_BUTTON || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!anchor || !anchor.closest(LANDING_ROOT_SELECTOR)) return;
      const sectionId = inPageSectionId(anchor.getAttribute('href') ?? '');
      if (sectionId === null) return;
      const section = document.getElementById(sectionId);
      if (section instanceof HTMLElement) section.focus({ preventScroll: true });
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}
