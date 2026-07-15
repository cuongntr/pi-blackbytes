/**
 * Bounded, metadata-only reconstruction of a JSONL session's active branch.
 * Raw identifiers are used only to HMAC map keys and the in-memory byte tie-break.
 */
import { Buffer } from "node:buffer";

import { hmacDigest } from "./evidence-store.js";

export const TOPOLOGY_EXCLUSION_REASONS = [
  "duplicate-structural-id",
  "invalid-line-index",
  "missing-parent",
  "no-terminal-leaf",
  "structural-cycle",
] as const;

export type TopologyExclusionReason = (typeof TOPOLOGY_EXCLUSION_REASONS)[number];

interface TopologyNode {
  readonly parentId?: string;
  readonly lineIndex: number;
  readonly idBytes: Buffer;
  readonly isAssistantUsage: boolean;
}

export interface FinalBranchTopology {
  readonly branchCount: number;
  readonly selectedLeafId?: string;
  readonly selectedLeafLineIndex?: number;
  readonly finalBranchEntryCount: number;
  readonly finalBranchRequestCount: number;
  readonly abandonedEntryCount: number;
  readonly reasons: readonly TopologyExclusionReason[];
}

function opaqueId(corpusKey: string, id: string): string {
  return hmacDigest(corpusKey, Buffer.from(id, "utf8"));
}

function compareUnsignedUtf8(left: Buffer, right: Buffer): number {
  return Buffer.compare(left, right);
}

/**
 * Receives one parsed non-header entry at a time. It retains only HMAC keyed
 * topology plus the minimum byte tie-break material; never parsed entries.
 */
export class BranchTopologyAccumulator {
  readonly #corpusKey: string;
  readonly #nodes = new Map<string, TopologyNode>();
  readonly #reasons = new Set<TopologyExclusionReason>();

  constructor(corpusKey: string) {
    this.#corpusKey = corpusKey;
  }

  add(id: unknown, parentId: unknown, lineIndex: number, isAssistantUsage: boolean): void {
    const isRoot = parentId === undefined || parentId === null;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      (!isRoot && (typeof parentId !== "string" || parentId.length === 0))
    ) {
      return;
    }
    if (!Number.isSafeInteger(lineIndex) || lineIndex < 1) {
      this.#reasons.add("invalid-line-index");
      return;
    }

    const key = opaqueId(this.#corpusKey, id);
    if (this.#nodes.has(key)) {
      this.#reasons.add("duplicate-structural-id");
      return;
    }

    this.#nodes.set(key, {
      ...(isRoot ? {} : { parentId: opaqueId(this.#corpusKey, parentId) }),
      lineIndex,
      // This is never emitted and exists solely for the specified byte-wise tie-break.
      idBytes: Buffer.from(id, "utf8"),
      isAssistantUsage,
    });
  }

  finalize(): FinalBranchTopology {
    const children = new Set<string>();
    for (const [id, node] of this.#nodes) {
      if (node.parentId === undefined) continue;
      children.add(node.parentId);
      if (!this.#nodes.has(node.parentId)) this.#reasons.add("missing-parent");
      if (node.parentId === id) this.#reasons.add("structural-cycle");
    }

    // Memoized iterative tri-state walk: 0 unseen, 1 visiting, 2 complete.
    // Each parent edge is traversed at most once, including very deep chains.
    const state = new Map<string, 0 | 1 | 2>();
    for (const startId of this.#nodes.keys()) {
      if (state.get(startId) === 2) continue;
      const path: string[] = [];
      let current: string | undefined = startId;
      while (current !== undefined && state.get(current) !== 2) {
        if (state.get(current) === 1) {
          this.#reasons.add("structural-cycle");
          break;
        }
        state.set(current, 1);
        path.push(current);
        current = this.#nodes.get(current)?.parentId;
      }
      for (const id of path) state.set(id, 2);
    }

    const leaves: Array<[string, TopologyNode]> = [];
    for (const entry of this.#nodes) {
      if (!children.has(entry[0])) leaves.push(entry);
    }
    if (leaves.length === 0) this.#reasons.add("no-terminal-leaf");

    let selected: [string, TopologyNode] | undefined;
    for (const candidate of leaves) {
      if (
        selected === undefined ||
        candidate[1].lineIndex > selected[1].lineIndex ||
        (candidate[1].lineIndex === selected[1].lineIndex &&
          compareUnsignedUtf8(candidate[1].idBytes, selected[1].idBytes) > 0)
      ) {
        selected = candidate;
      }
    }

    let finalBranchEntryCount = 0;
    let finalBranchRequestCount = 0;
    if (selected !== undefined) {
      const visited = new Set<string>();
      let current: string | undefined = selected[0];
      while (current !== undefined && !visited.has(current)) {
        visited.add(current);
        const node = this.#nodes.get(current);
        if (node === undefined) break;
        finalBranchEntryCount += 1;
        if (node.isAssistantUsage) finalBranchRequestCount += 1;
        current = node.parentId;
      }
    }

    return Object.freeze({
      branchCount: leaves.length,
      ...(selected === undefined
        ? {}
        : { selectedLeafId: selected[0], selectedLeafLineIndex: selected[1].lineIndex }),
      finalBranchEntryCount,
      finalBranchRequestCount,
      abandonedEntryCount: this.#nodes.size - finalBranchEntryCount,
      reasons: Object.freeze([...this.#reasons].sort()),
    });
  }
}
