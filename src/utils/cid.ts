export const CID_CHARS = "ZPMQVRWSNKTXJBYH";

// Cache to avoid recomputing CID for identical lines (common in large files)
const cidCache = new Map<string, string>();
const CID_CACHE_MAX_SIZE = 10_000;

export function computeCID(lineNum: number, content: string): string {
  const cacheKey = `${lineNum}:${content}`;
  const cached = cidCache.get(cacheKey);
  if (cached) return cached;

  let hash = lineNum * 31;
  // Match original normalization exactly: remove all \r, then trim trailing whitespace
  const normalized = content.replace(/\r/g, "").trimEnd();
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) & 0xffff;
  }
  const result = CID_CHARS[hash & 0xf] + CID_CHARS[(hash >> 4) & 0xf];

  // Evict oldest entries if cache grows too large
  if (cidCache.size >= CID_CACHE_MAX_SIZE) {
    const firstKey = cidCache.keys().next().value;
    if (firstKey !== undefined) cidCache.delete(firstKey);
  }
  cidCache.set(cacheKey, result);

  return result;
}
