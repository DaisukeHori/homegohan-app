/**
 * AI 相談のシートが提案を実行してデータ (献立・食事・買い物リスト・冷蔵庫・健康の記録・好みなど) を変えたことを、
 * タブの WebView の画面に知らせる (#2189 W2)。
 *
 * Web の AI 相談 (src/components/AIChatBubble.tsx) は、実行できたときに mealPlanUpdated を投げる。モバイルのタブは
 * Web の画面を WebView で開いている (app/(tabs)/home.tsx など) ので、シートで実行しても、閉じたあとのタブには古い中身が残っていた。
 * シート (AIAdvisorSheet) は実行できたときに notifyAiConsultationDataChanged を呼び、購読している WebView の画面
 * (WebViewScreen の reloadOnAiConsultationDataChange) が今のページを読み込み直す。
 */

type AiConsultationDataChangedListener = () => void;

const listeners = new Set<AiConsultationDataChangedListener>();

/** WebView の画面が購読する。戻り値で解除する */
export function subscribeAiConsultationDataChanged(listener: AiConsultationDataChangedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** AI 相談の提案の実行でデータが変わったことを知らせる。購読者が居なければ何もしない */
export function notifyAiConsultationDataChanged(): void {
  for (const listener of Array.from(listeners)) listener();
}

/** テスト用: 購読を全部外す */
export function resetAiConsultationDataChangedListenersForTests(): void {
  listeners.clear();
}
