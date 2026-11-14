/**
 * Local embedder used when VOYAGE_API_KEY is unset.
 * The first slice is a fixed dispute lexicon so "longer route" ranks above a
 * cancellation-fee note. The tail is a hashed bag of the remaining tokens.
 * Voyage voyage-4-large (1024 dims) replaces this when a key is set.
 */
const STOP = new Set(
  "a an the of and to in is was when we under unless only this are for on it that with from or be by at as if not no i same".split(
    " ",
  ),
);

export const LEXICON = [
  "route",
  "detour",
  "longer",
  "distance",
  "expected",
  "deviation",
  "km",
  "cancel",
  "cancellation",
  "fee",
  "arrived",
  "never",
  "duplicate",
  "twice",
  "double",
  "charged",
  "refund",
  "driver",
  "rider",
  "photo",
  "fare",
  "share",
  "platform",
  "complaint",
  "schedule",
  "reversal",
  "dismissed",
];

const HASH_DIMS = 64;
export const LOCAL_DIMENSIONS = LEXICON.length + HASH_DIMS;

export function localEmbedding(text, dimensions = LOCAL_DIMENSIONS) {
  const vec = new Array(dimensions).fill(0);
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .split(/\s+/)
    .filter((token) => token && !STOP.has(token));

  for (const token of tokens) {
    const known = LEXICON.indexOf(token);
    if (known >= 0 && known < dimensions) vec[known] += 5;
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const tail = dimensions - HASH_DIMS;
    if (tail > 0) vec[tail + (Math.abs(hash) % HASH_DIMS)] += 0.25 * (hash & 1 ? 1 : -1);
  }

  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vec.map((value) => value / norm);
}

export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) dot += a[i] * b[i];
  return dot;
}

export function rankByEmbedding(docs, queryEmbedding, limit = 4) {
  return docs
    .filter((doc) => Array.isArray(doc.embedding) && doc.embedding.length === queryEmbedding.length)
    .map((doc) => ({ doc, score: cosine(queryEmbedding, doc.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function embed(text, inputType = "document") {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (apiKey) {
    try {
      const response = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: [text],
          model: process.env.VOYAGE_MODEL || "voyage-4-large",
          input_type: inputType,
        }),
      });
      if (!response.ok) {
        throw new Error(`Voyage responded ${response.status}`);
      }
      const json = await response.json();
      const embedding = json?.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error("Voyage returned no embedding");
      }
      return { embedding, embedder: "voyage" };
    } catch (error) {
      console.warn(`Voyage embedding unavailable (${error.message}). Using the local embedder.`);
    }
  }
  return { embedding: localEmbedding(text), embedder: "local-fnv" };
}
