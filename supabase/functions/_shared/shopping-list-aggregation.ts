/**
 * 買い物リストの材料名寄せ合算（#1046 F5-13）
 *
 * 同名材料の出現(複数の食事・複数の日にまたがる)を、名前だけをキーに amount_g で
 * 確定合算する。従来は regenerate-shopping-list-v2 内で `${name}|${amountStr}` を
 * キーにしていたため、同じ材料でも日によって分量(g)が異なると別エントリになり、
 * 合算(200g+300g→500g)を LLM のプロンプト任せにしていた（結果不一致の原因）。
 * ここで g換算できる材料の合計gramを確定させ、LLMには表記整形のみを依頼する。
 *
 * Deno固有の import/実行(Deno.serve等)を含めず、Node(vitest)からも直接
 * import してユニットテストできるようにするため、edge function 本体
 * (index.ts) とは切り離して _shared 配下に置く。
 */

export interface InputIngredient {
  name: string;
  amount?: string | null;
  count: number;
}

export function aggregateIngredientOccurrences(
  occurrences: Array<{ name: string; amount_g: number }>
): InputIngredient[] {
  const aggregates = new Map<string, { name: string; totalAmountG: number; count: number }>();

  for (const occurrence of occurrences) {
    const name = occurrence.name?.trim();
    if (!name) continue;

    const existing = aggregates.get(name);
    if (existing) {
      existing.totalAmountG += occurrence.amount_g;
      existing.count += 1;
    } else {
      aggregates.set(name, { name, totalAmountG: occurrence.amount_g, count: 1 });
    }
  }

  return Array.from(aggregates.values()).map((agg) => ({
    name: agg.name,
    amount: agg.totalAmountG > 0 ? `${Math.round(agg.totalAmountG)}g` : null,
    count: agg.count,
  }));
}
