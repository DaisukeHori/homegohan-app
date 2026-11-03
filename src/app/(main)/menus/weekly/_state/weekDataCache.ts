/**
 * 献立表 (/menus/weekly) の週のキャッシュ (週の初日 YYYY-MM-DD → その週の献立と買い物リスト。#2201 U1)。
 *
 * キャッシュに書けるのは、書き込み口 (beginWrite が返す関数) だけ。書き込み口は、その週の読み取りを始める前に取る:
 *   - 捨てた (discard。AI 相談の成功の取り直し) あとは、捨てる前に取った書き込み口では書かない (捨てる前に始めた読み取り
 *     (週の読み込み・前後の週の先読み) の応答が、捨てたあとに届いても、AI 相談の前の献立をキャッシュに戻さない。
 *     戻すと、その週へ戻ったときにキャッシュから AI 相談の前の献立を出す)
 *   - 同じ週のあとの読み取りが書き込み口を取ったら、先の書き込み口では書かない (先に始めた読み取りの古い応答で、
 *     あとに始めた読み取りの応答を上書きしない)
 *   - 書き込み口を取ると、その週のキャッシュを捨てる (あとに始めた読み取りの応答を待つあいだに、それより前に読んだ献立を
 *     キャッシュから出さない。その週へ戻ったときは読み直す)
 */

/** キャッシュに置く 1 週分 (書いた時刻 fetchedAt は書き込み口が付ける) */
export type WeekDataCacheEntry<T> = T & { readonly fetchedAt: number };

/** 1 つの読み取りの応答をキャッシュに書く関数 (beginWrite が返す)。書いたら true、上の決まりで書かなかったら false */
export type WeekDataCacheWriter<T> = (data: T) => boolean;

export interface WeekDataCache<T> {
  /** その週のキャッシュ (無ければ undefined。古さ (fetchedAt) は呼ぶ側が見る) */
  readonly get: (weekStartKey: string) => WeekDataCacheEntry<T> | undefined;
  /**
   * その週の読み取りを始める前に呼ぶ: その週のキャッシュを捨て、その読み取りの応答を書く関数を返す
   * (捨てた (discard) あと・同じ週のあとの読み取りが書き込み口を取ったあとは書かない)
   */
  readonly beginWrite: (weekStartKey: string) => WeekDataCacheWriter<T>;
  /** 全部を捨てる (AI 相談の成功の取り直し)。捨てる前に取った書き込み口では、もう書かない */
  readonly discard: () => void;
}

export function createWeekDataCache<T extends object>(): WeekDataCache<T> {
  const entries = new Map<string, WeekDataCacheEntry<T>>();
  /** 週ごとの、最後に書き込み口を取った読み取りの番号 (discard で全部消す: 捨てる前の番号の書き込み口は書かない) */
  const latestReads = new Map<string, number>();
  /** 読み取りの番号 (書き込み口ごとに 1 つ進める。週をまたいで重ならない) */
  let readCount = 0;
  return {
    get: (weekStartKey) => entries.get(weekStartKey),
    beginWrite: (weekStartKey) => {
      readCount += 1;
      const read = readCount;
      latestReads.set(weekStartKey, read);
      entries.delete(weekStartKey);
      return (data) => {
        if (latestReads.get(weekStartKey) !== read) return false;
        entries.set(weekStartKey, { ...data, fetchedAt: Date.now() });
        return true;
      };
    },
    discard: () => {
      entries.clear();
      latestReads.clear();
    },
  };
}
