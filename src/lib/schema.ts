import { z } from "zod";

// 共通: ユーザープロフィール
export const UserProfileSchema = z.object({
  nickname: z.string().min(1, "ニックネームを入力してください").max(20, "20文字以内で入力してください"),
  ageGroup: z.string(),
  gender: z.string(),
  goalText: z.string().optional(),
  familySize: z.number().min(1).max(20).optional(),
  cheatDay: z.string().optional().nullable(),
});

// 献立リクエスト
export const WeeklyMenuRequestSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日付形式が正しくありません"),
  note: z.string().max(500, "要望は500文字以内で入力してください").optional(),
  familySize: z.number().min(1).max(10),
  cheatDay: z.string().optional().nullable(),
  // 制約条件などの複雑なオブジェクトもここで定義可能
});

// 法人メンバー追加
export const OrgMemberSchema = z.object({
  nickname: z.string().min(1),
  email: z.string().email("有効なメールアドレスを入力してください"),
  password: z.string().min(6, "パスワードは6文字以上で入力してください"),
});

// 今日のコンディション
export const ActivityLogSchema = z.object({
  feeling: z.enum(['rest', 'normal', 'active', 'stressed']),
  date: z.string(),
});


