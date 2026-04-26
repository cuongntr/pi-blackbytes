export const CID_CHARS = "ZPMQVRWSNKTXJBYH";

export function computeCID(lineNum: number, content: string): string {
  let hash = lineNum * 31;
  const normalized = content.replace(/\r/g, "").trimEnd();
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) & 0xffff;
  }
  return CID_CHARS[hash & 0xf] + CID_CHARS[(hash >> 4) & 0xf];
}
