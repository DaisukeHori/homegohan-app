// src/lib/admin/value-labels.ts
// 運営の画面で、英字の内部の値 (状態・区分) を表示名の表 (Record<値, string>) に通して出すための共通の部品 (#2112 Z3)。
// 表に無い値 (将来の値・壊れた応答) は、知らない値を隠さないようそのまま返す (運営は内部の値から原因を追える)。
// 利用者の画面の表 (src/lib/admin/moderation-labels.ts など) は、表に無い値を固定の文にする別の規則なので、これを使わない。
//
// このファイルはブラウザからも読むので、何も import しない。

/** value が表のキー (自分のプロパティ) か。Object.prototype のプロパティ (toString など) はキーにしない */
function isLabelKey<K extends string>(table: Readonly<Record<K, string>>, value: string): value is K {
  return Object.prototype.hasOwnProperty.call(table, value);
}

/** 表の値の表示名。表に無い値はそのまま返す */
export function labelOrRaw<K extends string>(table: Readonly<Record<K, string>>, value: string): string {
  return isLabelKey(table, value) ? table[value] : value;
}
