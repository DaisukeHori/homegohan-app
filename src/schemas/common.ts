// src/schemas/common.ts
// (設計書 01-data-model.md §1.1)
import { z } from 'zod';

export const ApiErrorSchema = z.object({
  code: z.string(),                    // 'NOT_FOUND', 'CONFLICT', 'FORBIDDEN', ...
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const apiSuccess = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ data, error: z.undefined().optional() });

export const apiFailure = z.object({
  data: z.undefined().optional(),
  error: ApiErrorSchema,
});

export const apiResponse = <T extends z.ZodTypeAny>(data: T) =>
  z.union([apiSuccess(data), apiFailure]);

export type ApiError = z.infer<typeof ApiErrorSchema>;
