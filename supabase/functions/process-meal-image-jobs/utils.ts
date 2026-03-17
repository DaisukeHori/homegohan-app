export interface GeneratedContentPart {
  text?: string;
  inlineData?: {
    mimeType?: string;
    data?: string;
  };
}

export function buildImageUploadPath(params: {
  plannedMealId: string;
  jobId: string;
  timestamp?: number;
}): string {
  const timestamp = params.timestamp ?? Date.now();
  return `generated/${params.plannedMealId}/${params.jobId}-${timestamp}.png`;
}

export function extractInlineImageBase64(parts: GeneratedContentPart[] | null | undefined): string | null {
  if (!Array.isArray(parts)) return null;

  for (const part of parts) {
    const mimeType = part?.inlineData?.mimeType;
    const data = part?.inlineData?.data;
    if (mimeType?.startsWith('image/') && data) {
      return data;
    }
  }

  return null;
}
