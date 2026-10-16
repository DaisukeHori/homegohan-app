'use client';

// src/components/membership/FamilyMenuRows.tsx
// 週間献立の「家族の表示」で、切り替えで選んだ家族のメンバーの献立を読み取り専用の行で描く部品と、日の末尾の注記
// (#1584 の 1・設計書 docs/design/family/10-family-menu-view.md §16.2)。
//
// - 行は読み取り専用: 編集・削除・並べ替え・完了のボタンを出さない (R-3)。押すと料理の名前 (dish_names) の箇条書きを開閉するだけ (T-18)。
// - 画像は描かない (応答の 1 食に画像の URL は無い。Q-8)。next/image・<img>・SignedPhotoImage を使わない。
// - 注記の文言は FAMILY_MENU_NOTE_TEXT だけを使う (ここに文言のリテラルを書かない)。注記は hook の status だけで出し分ける。
import { useState, type JSX } from 'react';
import type { MealType } from '@homegohan/shared';
import type { FamilyMember } from '@/schemas/membership';
import type { FamilyMenuData, FamilyMenuMeal } from '@/schemas/membership/family-menu';
import {
  FAMILY_MENU_NOTE_TEXT,
  familyMenuHasMealsOn,
  familyMenuMealLabel,
  familyMenuMealsOf,
  type FamilyMenuPartition,
} from '@/lib/membership/family-menu';
import type { FamilyMenuStatus } from '@/hooks/useFamilyMenu';
import { getMemberColor, getMemberDisplayName } from '@/components/membership/FamilyViewSwitcher';
import { colors } from '@/app/(main)/menus/weekly/_components/colors';

/** 注記の文の中の、メンバーの名前に置き換える印 (FAMILY_MENU_NOTE_TEXT の {name}) */
const NOTE_NAME_PLACEHOLDER = '{name}';

/** 行のアバターの大きさ (px)。FamilyViewSwitcher のシートの行のアバターと同じ */
const ROW_AVATAR_SIZE_PX = 28;

function noteText(template: string, name: string): string {
  return template.split(NOTE_NAME_PLACEHOLDER).join(name);
}

/** 切り替えの部品と同じ決め方のアバターの色 (active な一覧の中の順) */
function avatarColorOf(members: readonly FamilyMember[], member: FamilyMember): string {
  const active = members.filter((m) => m.status === 'active');
  const index = active.findIndex((m) => m.id === member.id);
  return getMemberColor(index >= 0 ? index : 0, member.avatar_color);
}

export interface FamilyMenuMealRowsProps {
  mealType: MealType;
  dayDate: string;
  members: readonly FamilyMember[];
  shownIds: readonly string[];
  menu: FamilyMenuData | null;
}

interface FamilyMenuMealRowProps {
  member: FamilyMember;
  avatarColor: string;
  meal: FamilyMenuMeal;
}

/** 家族の献立の 1 食 (読み取り専用)。開閉は部品の中の state (T-18) */
function FamilyMenuMealRow({ member, avatarColor, meal }: FamilyMenuMealRowProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const name = getMemberDisplayName(member);
  return (
    <div
      data-testid="family-menu-row"
      data-member-id={member.id}
      data-meal-id={meal.id}
      className="w-full rounded-[14px] mb-2 overflow-hidden"
      style={{ background: colors.card, border: `1px dashed ${colors.border}` }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-3.5 py-3 text-left"
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: ROW_AVATAR_SIZE_PX,
            height: ROW_AVATAR_SIZE_PX,
            borderRadius: '50%',
            backgroundColor: avatarColor,
            fontSize: 13,
            color: '#fff',
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {name.charAt(0)}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block" style={{ fontSize: 11, color: colors.textMuted }}>
            {name}
          </span>
          <span className="block truncate" style={{ fontSize: 14, fontWeight: 500, color: colors.text }}>
            {familyMenuMealLabel(meal)}
          </span>
        </span>
        <span className="flex items-center gap-2 flex-shrink-0" style={{ fontSize: 11, color: colors.textLight }}>
          {meal.calories_kcal !== null && <span>{meal.calories_kcal} kcal</span>}
          {meal.cooking_time_minutes !== null && <span>{meal.cooking_time_minutes} 分</span>}
          {meal.is_completed && (
            <span
              className="px-1.5 py-0.5 rounded"
              style={{ background: colors.successLight, color: colors.success, fontWeight: 600 }}
            >
              済
            </span>
          )}
        </span>
      </button>
      {open && (
        <ul className="px-4 pb-3 list-disc list-inside" style={{ fontSize: 13, color: colors.textLight }}>
          {meal.dish_names.map((dishName, index) => (
            <li key={`${meal.id}-${index}`}>{dishName}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** その区分の、見てよいメンバーの献立を読み取り専用の行で描く。1 行も無ければ null */
export function FamilyMenuMealRows({ mealType, dayDate, members, shownIds, menu }: FamilyMenuMealRowsProps): JSX.Element | null {
  if (menu === null) return null;
  const rows: JSX.Element[] = [];
  for (const id of shownIds) {
    const member = members.find((m) => m.id === id);
    if (!member) continue;
    const responseMember = menu.members.find((m) => m.member_id === id);
    const avatarColor = avatarColorOf(members, member);
    for (const meal of familyMenuMealsOf(responseMember, dayDate, mealType)) {
      rows.push(<FamilyMenuMealRow key={`${id}-${meal.id}`} member={member} avatarColor={avatarColor} meal={meal} />);
    }
  }
  if (rows.length === 0) return null;
  return <div data-testid="family-menu-meal-rows">{rows}</div>;
}

export interface FamilyMenuDayNotesProps {
  dayDate: string;
  members: readonly FamilyMember[];
  partition: FamilyMenuPartition;
  menu: FamilyMenuData | null;
  status: FamilyMenuStatus;
  onReload: () => void;
}

/** 注記 1 行の見た目 */
function NoteLine({ text }: { text: string }): JSX.Element {
  return (
    <p data-testid="family-menu-note" style={{ fontSize: 12, color: colors.textMuted }}>
      {text}
    </p>
  );
}

/** 日の末尾の注記 (status ごと: 読み込み中 / 読み込めなかった / 共有していない・アカウントが無い・この日は献立が無い)。無ければ null */
export function FamilyMenuDayNotes({ dayDate, members, partition, menu, status, onReload }: FamilyMenuDayNotesProps): JSX.Element | null {
  if (status === 'idle') return null;

  if (status === 'error') {
    return (
      <div data-testid="family-menu-notes" className="px-1 py-2 flex items-center gap-3">
        <NoteLine text={FAMILY_MENU_NOTE_TEXT.loadFailed} />
        <button
          type="button"
          onClick={onReload}
          className="px-2.5 py-1 rounded-lg"
          style={{ fontSize: 12, color: colors.accent, border: `1px solid ${colors.accent}`, background: colors.card }}
        >
          もう一度
        </button>
      </div>
    );
  }

  // 週を移った直後 (loading、または effect が loading にする前の ready で menu が null) は読み込み中の 1 行だけ。
  // 前の応答があっても「共有していない」「この日は献立が無い」などは出さない (T-17)
  if (status === 'loading' || menu === null) {
    return (
      <div data-testid="family-menu-notes" className="px-1 py-2">
        <NoteLine text={FAMILY_MENU_NOTE_TEXT.loading} />
      </div>
    );
  }

  // ready で menu がある (今の範囲の応答)
  const nameOf = (id: string): string | null => {
    const member = members.find((m) => m.id === id);
    return member ? getMemberDisplayName(member) : null;
  };
  const lines: { key: string; text: string }[] = [];
  for (const id of partition.notSharing) {
    const name = nameOf(id);
    if (name !== null) lines.push({ key: `notSharing-${id}`, text: noteText(FAMILY_MENU_NOTE_TEXT.notSharing, name) });
  }
  for (const id of partition.noAccount) {
    const name = nameOf(id);
    if (name !== null) lines.push({ key: `noAccount-${id}`, text: noteText(FAMILY_MENU_NOTE_TEXT.noAccount, name) });
  }
  for (const id of partition.shown) {
    const responseMember = menu.members.find((m) => m.member_id === id);
    if (familyMenuHasMealsOn(responseMember, dayDate)) continue;
    const name = nameOf(id);
    if (name !== null) lines.push({ key: `noMealsToday-${id}`, text: noteText(FAMILY_MENU_NOTE_TEXT.noMealsToday, name) });
  }
  if (lines.length === 0) return null;
  return (
    <div data-testid="family-menu-notes" className="px-1 py-2 flex flex-col gap-1">
      {lines.map((line) => (
        <NoteLine key={line.key} text={line.text} />
      ))}
    </div>
  );
}
