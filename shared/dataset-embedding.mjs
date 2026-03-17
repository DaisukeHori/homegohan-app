export const DATASET_EMBEDDING_PROVIDER = "aimlapi";
export const DATASET_EMBEDDING_API_URL = "https://api.aimlapi.com/v1/embeddings";
export const DATASET_EMBEDDING_API_KEY_ENV = "AIMLAPI_API_KEY";
export const DATASET_EMBEDDING_MODEL = "voyage-multilingual-2";
export const DATASET_EMBEDDING_DIMENSIONS = 1024;
export const DATASET_EMBEDDING_MODELS = [
  {
    value: DATASET_EMBEDDING_MODEL,
    label: DATASET_EMBEDDING_MODEL,
    dimensions: [DATASET_EMBEDDING_DIMENSIONS],
    provider: DATASET_EMBEDDING_PROVIDER,
  },
];

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toThemeTags(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function toDishes(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function buildMenuSetEmbeddingText(menu) {
  const title = String(menu?.title ?? "").trim();
  const theme = toThemeTags(menu?.theme_tags).join(" ");
  const dishLines = toDishes(menu?.dishes)
    .map((dish) => {
      const name = String(dish?.name ?? "").trim();
      const role = String(dish?.role ?? dish?.class_raw ?? "").trim();
      return name ? `${name}${role ? `(${role})` : ""}` : "";
    })
    .filter(Boolean)
    .join(" / ");
  const macro = [
    `kcal=${toFiniteNumber(menu?.calories_kcal) ?? "?"}`,
    `P=${toFiniteNumber(menu?.protein_g) ?? "?"}`,
    `F=${toFiniteNumber(menu?.fat_g) ?? "?"}`,
    `C=${toFiniteNumber(menu?.carbs_g) ?? "?"}`,
    `salt=${toFiniteNumber(menu?.sodium_g) ?? "?"}`,
  ].join(",");

  return [
    title ? `タイトル: ${title}` : null,
    theme ? `テーマ: ${theme}` : null,
    dishLines ? `料理: ${dishLines}` : null,
    `栄養: ${macro}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function isDatasetEmbeddingConfig(model, dimensions) {
  return model === DATASET_EMBEDDING_MODEL && Number(dimensions) === DATASET_EMBEDDING_DIMENSIONS;
}

export function getDatasetEmbeddingApiKey(getEnv) {
  if (typeof getEnv !== "function") {
    throw new Error("getEnv must be a function");
  }
  const apiKey = getEnv(DATASET_EMBEDDING_API_KEY_ENV);
  if (!apiKey) {
    throw new Error(`Missing ${DATASET_EMBEDDING_API_KEY_ENV}`);
  }
  return apiKey;
}

export function buildDatasetEmbeddingRequestBody(input, { inputType = "document" } = {}) {
  const body = {
    model: DATASET_EMBEDDING_MODEL,
    input,
  };

  // AIMLAPI の voyage-multilingual-2 は query input_type を受けないため、
  // 明示的に document が必要な時だけ指定し、それ以外は省略して互換運用する。
  if (inputType === "document") {
    body.input_type = "document";
  }

  return body;
}

/**
 * @typedef {Object} DatasetEmbeddingOptions
 * @property {string} [apiKey]
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [inputType]
 */

/**
 * @param {string|string[]} input
 * @param {DatasetEmbeddingOptions} [options]
 */
export async function fetchDatasetEmbeddings(
  input,
  {
    apiKey,
    fetchImpl = fetch,
    inputType = "document",
    timeoutMs = 15000,
  } = {},
) {
  if (!apiKey) {
    throw new Error(`Missing ${DATASET_EMBEDDING_API_KEY_ENV}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("dataset_embedding_timeout"), timeoutMs);

  let response;
  try {
    response = await fetchImpl(DATASET_EMBEDDING_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildDatasetEmbeddingRequestBody(input, { inputType })),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`Dataset embedding API timed out after ${timeoutMs}ms`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    const error = new Error(`Dataset embedding API error: ${errorText}`);
    error.status = response.status;
    throw error;
  }

  const json = await response.json();
  const data = json?.data;
  if (!Array.isArray(data)) {
    throw new Error("Dataset embedding API returned invalid data");
  }

  return data.map((item) => item?.embedding);
}

/**
 * @param {string} input
 * @param {DatasetEmbeddingOptions} [options]
 */
export async function fetchSingleDatasetEmbedding(
  input,
  options = {},
) {
  const embeddings = await fetchDatasetEmbeddings(input, options);
  const embedding = embeddings[0];
  if (!Array.isArray(embedding) || embedding.length !== DATASET_EMBEDDING_DIMENSIONS) {
    throw new Error("Dataset embedding API returned invalid vector");
  }
  return embedding;
}
