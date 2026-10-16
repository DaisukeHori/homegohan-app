// src/__tests__/app/menus/weekly/family-menu-wiring.test.ts
// 週間献立の「家族の表示」の page.tsx の配線の静的検査 (#1584 の 1・設計書 docs/design/family/10-family-menu-view.md §16.1・§19.4)。
// static-guard.test.ts と同じく page.tsx をソースとして読み、配線の式が設計どおりかを見る
// (6,000 行を超えるクライアントの画面は jsdom で描かないので、同じ式の動きは components/membership/family-menu-rows.test.tsx が見る)。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAGE_TSX_PATH = path.resolve(__dirname, '../../../../app/(main)/menus/weekly/page.tsx');
const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

/** loadFamilyData の useCallback の本体 (次の useEffect まで) */
function loadFamilyDataBlock(): string {
  const match = pageSource.match(/const loadFamilyData = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[\]\);/);
  expect(match, 'loadFamilyData の useCallback が見つかりません').not.toBeNull();
  return match![0];
}

/** FamilyViewSwitcher の要素 (閉じるまで) */
function switcherBlock(): string {
  const match = pageSource.match(/<FamilyViewSwitcher[\s\S]*?\/>/);
  expect(match, 'FamilyViewSwitcher の要素が見つかりません').not.toBeNull();
  return match![0];
}

/** `{NAME.map(type => {` から、その map の終わり `})}` までの塊 */
function mealTypeMapBlock(name: 'BASE_MEAL_TYPES' | 'EXTRA_MEAL_TYPES'): string {
  const start = pageSource.indexOf(`{${name}.map(type => {`);
  expect(start, `${name} の map が見つかりません`).toBeGreaterThan(-1);
  const end = pageSource.indexOf('\n        })}', start);
  expect(end).toBeGreaterThan(start);
  return pageSource.slice(start, end);
}

describe('page.tsx: 週間献立の家族の表示の配線 (#1584 の 1)', () => {
  it('loadFamilyData が fetchFamilyMemberNames と applyFamilyMemberNames を呼び、setFamilyMembers に渡すのは applyFamilyMemberNames の結果', () => {
    const block = loadFamilyDataBlock();
    expect(block).toMatch(/await fetchFamilyMemberNames\(\)/);
    expect(block).toMatch(/setFamilyMembers\(applyFamilyMemberNames\(/);
    // 名前を当てない一覧を渡す書き方 (setFamilyMembers(members as FamilyMember[])) に戻っていない
    expect(block).not.toMatch(/setFamilyMembers\(members as FamilyMember\[\]\)/);
    expect(pageSource).toMatch(
      /import \{ applyFamilyMemberNames, fetchFamilyMemberNames \} from "@\/lib\/membership\/family-member-names";/,
    );
  });

  it('loadFamilyData は useCallback で、family_id が無いとき setFamilyId(null) と setFamilyMembers([]) を呼ぶ', () => {
    const block = loadFamilyDataBlock();
    expect(block).toMatch(/if \(!profile\?\.family_id\) \{\s*setFamilyId\(null\);\s*setFamilyMembers\(\[\]\);\s*return;\s*\}/);
    // 開いたときに呼ぶ effect
    expect(pageSource).toMatch(/useEffect\(\(\) => \{\s*void loadFamilyData\(\);\s*\}, \[loadFamilyData\]\);/);
    // effect の中の関数 (const loadFamilyData = async () =>) に戻っていない
    expect(pageSource).not.toMatch(/const loadFamilyData = async \(\) =>/);
  });

  it('FamilyViewSwitcher の onChange が setView と familyMenu.reload と loadFamilyData を呼ぶ', () => {
    const block = switcherBlock();
    expect(block).not.toMatch(/onChange=\{setView\}/);
    const onChange = block.match(/onChange=\{\(next\) => \{([\s\S]*?)\}\}/);
    expect(onChange, 'onChange の handler が見つかりません').not.toBeNull();
    const body = onChange![1];
    expect(body).toMatch(/setView\(next\);/);
    expect(body).toMatch(/familyMenu\.reload\(\);/);
    expect(body).toMatch(/void loadFamilyData\(\);/);
  });

  it('BASE_MEAL_TYPES と EXTRA_MEAL_TYPES の map の中に FamilyMenuMealRows がある', () => {
    for (const name of ['BASE_MEAL_TYPES', 'EXTRA_MEAL_TYPES'] as const) {
      const block = mealTypeMapBlock(name);
      expect(block, name).toMatch(/<FamilyMenuMealRows\s+mealType=\{type\}/);
      expect(block, name).toMatch(/shownIds=\{familyMenuPartition\.shown\}/);
      expect(block, name).toMatch(/menu=\{familyMenu\.data\}/);
      // 自分のカード群の後、AI 生成中のカードの前
      const rows = block.indexOf('<FamilyMenuMealRows');
      expect(block.indexOf('<CollapsedMealCard'), name).toBeLessThan(rows);
      expect(block.indexOf('{isGeneratingThisType && ('), name).toBeGreaterThan(rows);
    }
    // EXTRA は自分の献立も家族の献立も無い区分を描かない
    expect(mealTypeMapBlock('EXTRA_MEAL_TYPES')).toMatch(
      /if \(meals\.length === 0 && familyMealsCount === 0 && !isGeneratingThisType\) return null;/,
    );
  });

  it('FamilyMenuDayNotes を描く', () => {
    const match = pageSource.match(/<FamilyMenuDayNotes[\s\S]*?\/>/);
    expect(match, 'FamilyMenuDayNotes が見つかりません').not.toBeNull();
    const block = match![0];
    expect(block).toMatch(/partition=\{familyMenuPartition\}/);
    expect(block).toMatch(/status=\{familyMenu\.status\}/);
    expect(block).toMatch(/onReload=\{familyMenu\.reload\}/);
    // 日の末尾 = EXTRA の map の後、「食事を追加」の前
    const notes = pageSource.indexOf('<FamilyMenuDayNotes');
    expect(pageSource.indexOf('{EXTRA_MEAL_TYPES.map(type => {')).toBeLessThan(notes);
    expect(pageSource.indexOf("onClick={() => setActiveModal('addMealSlot')}")).toBeGreaterThan(notes);
  });

  it('page.tsx に家族の献立の useState を足していない (状態は hook)', () => {
    expect(pageSource).toMatch(/const familyMenu = useFamilyMenu\(\{/);
    expect(pageSource).toMatch(/enabled: familyId !== null && otherIds\.length > 0,/);
    const familyMenuStates = [...pageSource.matchAll(/const \[(\w+), \w+\] = useState/g)]
      .map((m) => m[1])
      .filter((name) => /familyMenu|familyMeal|otherIds|partition/i.test(name));
    expect(familyMenuStates).toEqual([]);
  });
});
