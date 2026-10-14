// src/components/common/dialogStack.ts
// #1052 (体系的 a11y): BottomSheet.tsx が内部に持っていた「開いているダイアログの
// スタック管理（背景スクロールロックの参照カウント / Escape の多重発火防止）」を
// 独立モジュールに切り出したもの。
//
// 切り出す理由: #1052 で weekly の19モーダルのうち BottomSheet を使わない既存の
// 「自前 motion.div ルート」型モーダル（AddFridgeModal 等）にも同じ Escape 調整
// ロジックを後付けする（useDialogA11y.ts）必要があるが、モジュールスコープの配列
// (openSheetStack) を BottomSheet.tsx と useDialogA11y.ts の2箇所で別々に持つと、
// 「BottomSheet ベースの ConfirmDeleteModal が レガシーモーダルの上に重ねて開く」
// （例: ShoppingModal 表示中に全削除確認モーダルを開く）ケースで、両者が別々の
// スタックに対して「自分が最前面か」を判定してしまい、Escape 1回で両方閉じる
// 多重発火バグが再発する。単一モジュールを共有させることでこれを防ぐ。

/**
 * 背景スクロールロック。開いているダイアログがある間、body のスクロールを止める。
 * 複数のダイアログが同時に開いても、最後に閉じたものが元の overflow に復元するよう
 * ネストカウントで管理する。
 */
let scrollLockCount = 0;
let previousBodyOverflow: string | null = null;

export function lockBodyScroll() {
  if (typeof document === "undefined") return;
  if (scrollLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLockCount += 1;
}

export function unlockBodyScroll() {
  if (typeof document === "undefined") return;
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = previousBodyOverflow ?? "";
    previousBodyOverflow = null;
  }
}

/**
 * 開いているダイアログ（BottomSheet / useDialogA11y 経由のレガシーモーダル問わず）の
 * id をスタックで管理する。Escape ハンドラは「自分が最上位（最後に開いた=最前面）か」を
 * 判定してから処理することで、何個開いていても最前面の1枚だけが閉じるようにする。
 */
const openDialogStack: string[] = [];

export function pushOpenDialog(id: string) {
  if (!openDialogStack.includes(id)) {
    openDialogStack.push(id);
  }
}

export function popOpenDialog(id: string) {
  const idx = openDialogStack.indexOf(id);
  if (idx !== -1) {
    openDialogStack.splice(idx, 1);
  }
}

export function isTopmostOpenDialog(id: string): boolean {
  return openDialogStack[openDialogStack.length - 1] === id;
}
