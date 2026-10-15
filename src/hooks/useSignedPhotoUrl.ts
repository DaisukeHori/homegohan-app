'use client';

/**
 * 保存された写真の URL を、表示に使う URL にする (#1365 段 1)。
 *   - 食事写真・冷蔵庫写真のバケットの URL: サーバーが本人の写真だと確かめて署名した URL。
 *     答えが来るまで・本人の写真でない・問い合わせに失敗したときは null (表示しない)
 *   - それ以外の URL (料理の見本画像・外部の画像など): そのまま
 *   - null / undefined / 空: null
 * 署名付き URL の期限が近づいたら取り直す (画面を開いたままでも、遅延読み込みの画像が期限切れにならないように)。
 */
import { useEffect, useState } from 'react';
import { isPhotoStorageUrl, type ResolvedPhotoUrl } from '@homegohan/shared';
import { getSignedPhotoUrlResolver } from '@/lib/signed-photo-url-client';

interface State {
  source: string;
  resolved: ResolvedPhotoUrl;
}

export function useSignedPhotoUrl(source: string | null | undefined): string | null {
  const [state, setState] = useState<State | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!source || !isPhotoStorageUrl(source)) return undefined;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    void getSignedPhotoUrlResolver()
      .resolve(source)
      .then((resolved) => {
        if (cancelled) return;
        setState({ source, resolved });
        if (resolved.refreshAt !== null) {
          refreshTimer = setTimeout(() => setGeneration((value) => value + 1), Math.max(0, resolved.refreshAt - Date.now()));
        }
      });
    return () => {
      cancelled = true;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  }, [source, generation]);

  if (!source) return null;
  if (!isPhotoStorageUrl(source)) return source;
  if (state && state.source === source) return state.resolved.url;
  // 別の画面ですでに答えを受け取っていれば、最初の描画からそれを使う (問い合わせの答えを待つあいだのちらつきを減らす)
  return getSignedPhotoUrlResolver().peek(source)?.url ?? null;
}
