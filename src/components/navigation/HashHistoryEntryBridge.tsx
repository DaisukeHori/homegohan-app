'use client';

// #1867: ハッシュだけの移動で積まれた履歴の項目を、Next の app router が「戻る / 進む」で描き直せるようにする (判定は src/lib/navigation/hash-history-entry.ts)。
// ルートの layout (src/app/layout.tsx) に 1 つだけ置く。画面には何も描かない。
//
// 例: `/` でヘッダーの「使い方」(<a href="#how">) → 「無料で始める」(next/link の /signup) → ブラウザの戻る。
// 直す前は URL だけ `/#how` に戻り、画面は `/signup` のままだった (`#how` の項目の history.state が null で、app router が popstate を無視するため)。
// useRouter は使わない (app router の外 (ルートの layout を単体で描くテスト) で例外になる。usePathname / useSearchParams は外では null を返す)。
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  decideOnHashChange,
  decideOnPopState,
  toRouteLocation,
  type RouteLocation,
} from '@/lib/navigation/hash-history-entry';
import { reloadCurrentDocument } from '@/lib/navigation/reload-document';

function currentRouteLocation(): RouteLocation {
  return { pathname: window.location.pathname, search: window.location.search };
}

export function HashHistoryEntryBridge() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // いま画面に描かれているルート。イベントの中で読むので ref に写す (描き直しの後の effect で更新する)
  const renderedRef = useRef<RouteLocation | null>(null);
  const searchString = searchParams ? searchParams.toString() : null;

  useEffect(() => {
    renderedRef.current = toRouteLocation(pathname, searchString);
  }, [pathname, searchString]);

  useEffect(() => {
    const onHashChange = () => {
      if (decideOnHashChange(window.history.state, renderedRef.current, currentRouteLocation()) !== 'mark-entry') return;
      // Next が差し替えた replaceState を通す。Next は印と今の画面の木を、この項目の state に入れ直す (URL は変わらない・スクロールしない)
      window.history.replaceState(window.history.state, '', window.location.href);
    };
    const onPopState = (event: PopStateEvent) => {
      if (decideOnPopState(event.state, renderedRef.current, currentRouteLocation()) !== 'redraw') return;
      // 印の無い項目 (印を付ける前に積まれた項目) へ戻ってきて、画面だけ前のまま残ったとき: 今の URL で読み込み直す
      // (Next の handlePopState の注記「外で積まれた項目は読み込み直すべき」と同じ扱い。ハッシュがあればブラウザがその区切りまでスクロールする)。
      // location.replace(同じ URL) は同じ文書の中のハッシュの移動になり読み込み直さないので、reload を使う
      reloadCurrentDocument();
    };
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  return null;
}
