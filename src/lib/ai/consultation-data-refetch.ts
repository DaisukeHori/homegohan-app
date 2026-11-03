/**
 * Web の AI 相談の提案の実行でデータが変わったときに、開いているページのデータを取り直す決まり (#2195 V1)。
 *
 * 問題:
 *   - Web の AI 相談 (src/components/AIChatBubble.tsx) は、献立の作成・変更・買い物リストへの追加などが成功すると
 *     window に AI_CONSULTATION_DATA_CHANGED_EVENT を投げるが、受け取るページが 1 つも無かった。チャットには
 *     『✅ …を実行しました！』が出るのに、開いている献立表などは古い表示のまま (自分で読み込み直すまで) だった
 *   - モバイルは #2189 W2 で、同じ成功のときにタブの WebView を読み込み直す (apps/mobile/src/lib/webViewBridge.ts の
 *     buildReloadCurrentPageScript)。Web だけが取り残されていた
 *
 * 決まり:
 *   - データを出すページは useAiConsultationDataRefetch (src/hooks/useAiConsultationDataRefetch.ts) でこの通知を受け、
 *     そのページの既存の取得の関数を呼んで取り直す。ページ全体の reload はしない
 *   - 入力の部品・開いているモーダルがページにある間は取り直さない (isAiConsultationRefetchBlocked)。取り直しで
 *     編集の途中の値 (取得した値から作る入力欄など) を上書きしないため。モバイルの AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR と
 *     同じ考え。ただし AI 相談の吹き出しの中 (AI_CONSULTATION_CHAT_ROOT_ATTRIBUTE を付けた要素の中) は数えない:
 *     Web では吹き出しが開いたまま (送信の入力欄があるまま) 実行が成功するので、数えると一度も取り直せない
 *     (モバイルでは Web の吹き出しは何も描かないので、この除外は要らない)
 *   - モーダルは role="dialog" (または aria-modal="true") で見分ける。受け手のページのモーダルはこれを持たせる:
 *     中に入力の部品が無い状態 (マイページの編集の競技タブ・削除の確認など) でも、開いている間は取り直さないため
 *   - 入力欄がいつも出ている部品 (/profile/nutrition-targets の栄養目標の再設定) は、入力欄の値が取得した値のまま
 *     (まだ何も変えていない) の間だけ、包む要素に AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE を付ける。その中の入力の部品は
 *     数えない (取り直しても失う打ちかけの値が無い。取り直しは取得した値を新しい値に置き換えるだけで、読み込み直したときと同じ)。
 *     付けないと、その部品のあるページは一度も取り直せない。モーダルは中にあっても数える
 *
 * このファイルはブラウザでだけ使う (サーバーの依存を import しない)。
 */

/**
 * AI 相談の提案の実行でデータが変わったときに Web の AI 相談が window に投げるイベントの名前。
 * 投げる側 (src/components/AIChatBubble.tsx) は文字列をそのまま書いているので、名前が一致していることは
 * tests/ai-consultation-data-refetch-2195.test.tsx が確かめる
 */
export const AI_CONSULTATION_DATA_CHANGED_EVENT = 'mealPlanUpdated';

/**
 * AI 相談の吹き出しを包む要素に付ける属性 (src/app/(main)/MainLayout.tsx)。この属性を持つ要素の中の入力欄・モーダルは、
 * 取り直しを止める理由にしない (吹き出しの送信の入力欄・吹き出しの中の 1 日献立変更のモーダル)
 */
export const AI_CONSULTATION_CHAT_ROOT_ATTRIBUTE = 'data-ai-consultation-chat-root';

/**
 * 入力欄の値が取得した値のまま (まだ何も変えていない) の部品を包む要素に、その間だけ付ける属性
 * (src/components/nutrition/nutrition-target-planner.tsx)。この属性を持つ要素の中の入力の部品 (AI_CONSULTATION_REFETCH_INPUT_SELECTOR) は、
 * 取り直しを止める理由にしない。中のモーダル (AI_CONSULTATION_REFETCH_MODAL_SELECTOR) は数える
 */
export const AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE = 'data-ai-consultation-unedited-inputs';

/**
 * 打ちかけの値を持ちうる入力の部品 (hidden・file を除く input・textarea・select・編集できる要素)。
 * input の type="file" を数えないのはモバイルとの違い (下の AI_CONSULTATION_REFETCH_BLOCKING_SELECTOR を見よ)
 */
const AI_CONSULTATION_REFETCH_INPUT_PARTS = [
  'input:not([type="hidden"]):not([type="file"])',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
] as const;

/** 開いているモーダル (role="dialog"・aria-modal・開いた <dialog>) */
const AI_CONSULTATION_REFETCH_MODAL_PARTS = ['[role="dialog"]', '[aria-modal="true"]', 'dialog[open]'] as const;

/** 打ちかけの値を持ちうる入力の部品のセレクタ */
export const AI_CONSULTATION_REFETCH_INPUT_SELECTOR = AI_CONSULTATION_REFETCH_INPUT_PARTS.join(', ');

/** 開いているモーダルのセレクタ */
export const AI_CONSULTATION_REFETCH_MODAL_SELECTOR = AI_CONSULTATION_REFETCH_MODAL_PARTS.join(', ');

/**
 * これに当たる要素が (AI 相談の吹き出しの外に) ある間は取り直さない。
 * 入力の部品 (AI_CONSULTATION_REFETCH_INPUT_SELECTOR) と、開いているモーダル (AI_CONSULTATION_REFETCH_MODAL_SELECTOR)。
 * モバイルの AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR と同じ並びで、違いは
 * input の type="file" を数えないことだけ: ファイルの選択の部品は打ちかけの値を持たず (選んだらすぐ送る)、/pantry の
 * 「写真で追加」のように画面に出さないファイルの選択がいつも置いてあるページがあるため (数えると一度も取り直せない)。
 * 2 つの並びが揃っていることは tests/ai-consultation-data-refetch-2195.test.tsx が確かめる
 */
export const AI_CONSULTATION_REFETCH_BLOCKING_SELECTOR = [
  ...AI_CONSULTATION_REFETCH_INPUT_PARTS,
  ...AI_CONSULTATION_REFETCH_MODAL_PARTS,
].join(', ');

/**
 * いま取り直すと入力の途中を上書きしうるか (true なら取り直さない)。
 * AI 相談の吹き出しの中 (AI_CONSULTATION_CHAT_ROOT_ATTRIBUTE の要素の中) の要素は数えない。
 * 何も変えていない入力欄の部品の中 (AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE の要素の中) の入力の部品も数えない (モーダルは数える)
 */
export function isAiConsultationRefetchBlocked(root: ParentNode): boolean {
  const chatRootSelector = `[${AI_CONSULTATION_CHAT_ROOT_ATTRIBUTE}]`;
  const uneditedInputsSelector = `[${AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE}]`;
  for (const element of Array.from(root.querySelectorAll(AI_CONSULTATION_REFETCH_BLOCKING_SELECTOR))) {
    if (element.closest(chatRootSelector)) continue;
    if (element.closest(uneditedInputsSelector) && element.matches(AI_CONSULTATION_REFETCH_INPUT_SELECTOR)) continue;
    return true;
  }
  return false;
}

/** AI 相談の吹き出しを包む要素に広げる属性 (src/app/(main)/MainLayout.tsx)。値は空 (付いていることだけが印) */
export const AI_CONSULTATION_CHAT_ROOT_PROPS: Readonly<Record<typeof AI_CONSULTATION_CHAT_ROOT_ATTRIBUTE, ''>> = {
  [AI_CONSULTATION_CHAT_ROOT_ATTRIBUTE]: '',
};

/** 何も変えていない入力欄の部品を包む要素に広げる属性 (AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE)。値は空 (付いていることだけが印) */
export const AI_CONSULTATION_UNEDITED_INPUTS_PROPS: Readonly<Record<typeof AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE, ''>> = {
  [AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE]: '',
};
