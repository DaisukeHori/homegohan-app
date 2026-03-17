import { describe, expect, it } from 'vitest';

import { buildImageUploadPath, extractInlineImageBase64, GeneratedContentPart } from '../supabase/functions/process-meal-image-jobs/utils';

describe('process meal image helpers', () => {
  it('builds a timestamped upload path', () => {
    const path = buildImageUploadPath({ plannedMealId: 'meal-123', jobId: 'job-abc', timestamp: 1_700_000_000 });
    expect(path).toBe('generated/meal-123/job-abc-1700000000.png');
  });

  it('extracts base64 from image part', () => {
    const parts: GeneratedContentPart[] = [
      { text: 'note' },
      { inlineData: { mimeType: 'image/png', data: 'ZmFrZQ==' } },
    ];
    expect(extractInlineImageBase64(parts)).toBe('ZmFrZQ==');
  });

  it('returns null when image data missing', () => {
    expect(extractInlineImageBase64([])).toBeNull();
    expect(extractInlineImageBase64(null)).toBeNull();
  });
});
