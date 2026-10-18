'use client';

// id で指す複数の要素の「いま帯と交差しているか」を 1 つの IntersectionObserver で見続ける hook
// (docs/design/marketing/01-landing-site.md §6.3・§8.3 の useInViewIds)。
// 物語の手順 (StoryScroller。帯 = STORY_BAND_ROOT_MARGIN) と、ヘッダーのナビの強調 (SiteHeader。帯 = NAV_CURRENT_ROOT_MARGIN) が使う。
// - マウントの後に ids の要素を document.getElementById で取り、見つからない id は飛ばす。
// - threshold は 0 (1 px でも交差したら交差とみなす)。どこを帯にするかは引数の rootMargin で決める (useInViewOnce と同じ考え方)。
// - 監視は続ける (unobserve しない)。アンマウントで disconnect。ids か rootMargin が変わったら作り直す。
// - IntersectionObserver が無い環境では全部 false を返す (物語は 1 枚目のまま・ナビは強調なし)。
// - 戻り値は ids の順の配列。refs を返す形は作らない。
import { useEffect, useState } from 'react';

/** 1 px でも交差したら通知する (割合にすると、画面より高い要素が交差したと見なされない) */
const ANY_INTERSECTION = 0;
/** ids を依存の鍵 1 つにまとめるときの区切り (要素の id に改行は入らない) */
const IDS_KEY_SEPARATOR = '\n';

export function useInViewIds(ids: ReadonlyArray<string>, rootMargin: string): ReadonlyArray<boolean> {
  const idsKey = ids.join(IDS_KEY_SEPARATOR);
  const [intersecting, setIntersecting] = useState<ReadonlyArray<boolean>>(() => ids.map(() => false));

  useEffect(() => {
    const list = idsKey === '' ? [] : idsKey.split(IDS_KEY_SEPARATOR);
    const current = list.map(() => false);
    setIntersecting(current);
    if (typeof IntersectionObserver === 'undefined') return;
    const indexOf = new Map(list.map((id, index) => [id, index] as const));
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const index = indexOf.get(entry.target.id);
          if (index === undefined || current[index] === entry.isIntersecting) continue;
          current[index] = entry.isIntersecting;
          changed = true;
        }
        if (changed) setIntersecting([...current]);
      },
      { threshold: ANY_INTERSECTION, rootMargin },
    );
    for (const id of list) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [idsKey, rootMargin]);

  return intersecting;
}
