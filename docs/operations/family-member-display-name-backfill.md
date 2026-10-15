# 承諾済みメンバーの display_name を埋める (#1584 の 2・未実施)

`20261015120000_accept_copies_profile_name.sql` から、家族の招待の承諾 (`accept_family_invite`) と子供の昇格の承諾
(`accept_child_promotion`) は、承諾した本人のプロフィールの名前 (`user_profiles.nickname`) を `family_members.display_name` に写す。
この migration より前に承諾した行は `display_name` が NULL のまま残る。

この文書は、その既存の行を埋めるかどうかを決めるための SQL の案だけを置く。**本番のデータを書き換えるのでオーナーの承認が要る。**
承認が無いまま流さない。流すときも本番への直接 SQL は禁止で、新しい migration として PR → main マージ → CI で適用する。

家族の画面は、display_name が NULL でもプロフィールの今の名前で補って出す (#1607 の `GET /api/family/members/names`)。
埋めなくても家族の 4 画面の表示は変わらない。補わずに display_name だけを読む所 (週間献立の家族の表示の切り替え
`src/components/membership/FamilyViewSwitcher.tsx`) は「メンバー」と出る。

## 名前の判定

`@homegohan/shared` の `normalizeProfileName` (`packages/shared/src/profile-name.ts`) と同じ。migration の 2 関数と同じ式を使う。

- 前後の空白を除く。除く文字は JavaScript の `String.prototype.trim` と同じ集合 (下の `btrim` の第 2 引数)
- 除いた結果が空なら名前なし
- 仮置きの `'Guest'` (前後の空白を除いて厳密一致) も名前なし
- 名前なしの人は埋めない (NULL のまま)

## 1. 件数を数える (読み取りだけ)

```sql
WITH candidates AS (
  SELECT fm.id, fm.status,
         NULLIF(btrim(up.nickname, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), '') AS profile_name
    FROM family_members fm
    JOIN user_profiles up ON up.id = fm.user_id
   WHERE fm.user_id IS NOT NULL
     AND NULLIF(btrim(fm.display_name, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), '') IS NULL
)
SELECT status,
       COUNT(*) AS rows_without_name,
       COUNT(*) FILTER (WHERE profile_name IS NOT NULL AND profile_name <> 'Guest') AS rows_to_fill
  FROM candidates
 GROUP BY status
 ORDER BY status;
```

## 2. 埋める (承認されたときだけ。新しい migration として)

active の行だけを対象にする (退出・除名済みの行は画面に出ない)。承諾の関数と同じく、すでに名前が入っている行は上書きしない。

```sql
UPDATE family_members fm
   SET display_name = src.profile_name
  FROM (
    SELECT up.id AS user_id, NULLIF(btrim(up.nickname, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), '') AS profile_name
      FROM user_profiles up
  ) src
 WHERE src.user_id = fm.user_id
   AND fm.status = 'active'
   AND NULLIF(btrim(fm.display_name, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), '') IS NULL
   AND src.profile_name IS NOT NULL
   AND src.profile_name <> 'Guest';
```

- service_role / migration (所有者 postgres) で流す。`guard_family_members_privileged` は display_name を守っていないので、止められない。
- 戻し方: 埋めた行の id を先に控えておき、その行だけ `display_name = NULL` に戻す (埋める前の値はすべて NULL か空白だけ)。
