import type { DelegateFailureKind } from "./types.js";

export const MAX_WAITING_WRITERS = 100;
const MAX_TIMER_MS = 2_147_483_647;

/** Clock callbacks must be asynchronous, like setTimeout. Deadlines use now()'s domain. */
export interface WriterAdmissionClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

const systemClock: WriterAdmissionClock = {
  now: Date.now,
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export interface WriterAdmissionFailure {
  success: false;
  failureKind: Extract<DelegateFailureKind, "failed" | "cancelled" | "timed_out">;
  /** Fixed, bounded text: never includes invocation context or abort reasons. */
  details: string;
}

export interface WriterLease<T> {
  readonly context: T;
  /** Cancellation requests settlement; it does NOT release capacity. */
  readonly signal: AbortSignal;
  /** Recheck immediately before spawn, without an intervening await. */
  check(): WriterAdmissionFailure | undefined;
  /** Call only from the owning invocation's final settlement path (including no-spawn). */
  release(): void;
}

export type WriterAdmissionResult<T> =
  | { success: true; lease: WriterLease<T> }
  | WriterAdmissionFailure;

export interface WriterAdmissionRequest<T> {
  context: T;
  signal?: AbortSignal;
  /** Absolute deadline, covering both waiting and the active lease. */
  deadline?: number;
}

interface Entry {
  state: "waiting" | "active" | "cancelled" | "released";
  failure?: WriterAdmissionFailure;
  check(): WriterAdmissionFailure | undefined;
  cancel(failure: WriterAdmissionFailure): void;
  grant(): void;
}

function failure(
  failureKind: WriterAdmissionFailure["failureKind"],
  details: string,
): WriterAdmissionFailure {
  return { success: false, failureKind, details };
}

const cancelled = () => failure("cancelled", "Writer admission cancelled.");
const timedOut = () => failure("timed_out", "Writer deadline expired before settlement.");
const closed = () => failure("cancelled", "Writer admission is closed; start a new session.");

/**
 * Runtime-local, capacity-one FIFO. No spawn, retries, filesystem, or persistence.
 * A resolved acquisition may be cancelled before its continuation runs: consumers
 * MUST check the lease pre-spawn and MUST release in finally, even when not spawning.
 * Active cancellation/close retains capacity until that owner settles. This helper
 * alone does not provide process settlement or a cross-generation reload barrier.
 */
export class WriterAdmissionController<T = unknown> {
  private readonly queue: Entry[] = [];
  private active?: Entry;
  private isClosed = false;

  constructor(private readonly clock: WriterAdmissionClock = systemClock) {}

  get waitingCount(): number {
    return this.queue.length;
  }

  get hasActiveLease(): boolean {
    return this.active !== undefined;
  }

  acquire(request: WriterAdmissionRequest<T>): Promise<WriterAdmissionResult<T>> {
    // Snapshot handles/deadline; later caller mutation cannot change admission policy.
    const { context, signal, deadline } = request;
    if (this.isClosed) return Promise.resolve(closed());
    if (deadline !== undefined && !Number.isFinite(deadline)) {
      return Promise.resolve(failure("failed", "Writer deadline must be finite."));
    }
    if (signal?.aborted) return Promise.resolve(cancelled());
    if (deadline !== undefined && this.clock.now() >= deadline) {
      return Promise.resolve(timedOut());
    }
    if (this.active && this.queue.length >= MAX_WAITING_WRITERS) {
      return Promise.resolve(
        failure("failed", "Writer queue is busy (100 waiting); wait for a writer to settle."),
      );
    }

    return new Promise((resolve) => {
      const controller = new AbortController();
      let disposeTimer: (() => void) | undefined;
      const onAbort = () => entry.cancel(cancelled());
      const cleanup = () => {
        disposeTimer?.();
        disposeTimer = undefined;
        signal?.removeEventListener("abort", onAbort);
      };
      const entry: Entry = {
        state: "waiting",
        check: () => {
          if (entry.failure) return entry.failure;
          if (entry.state === "released") {
            return failure("failed", "Writer lease already released.");
          }
          if (this.isClosed) entry.cancel(closed());
          else if (signal?.aborted) entry.cancel(cancelled());
          else if (deadline !== undefined && this.clock.now() >= deadline) {
            entry.cancel(timedOut());
          }
          return entry.failure;
        },
        cancel: (reason) => {
          if (entry.failure || entry.state === "released") return;
          entry.failure = reason;
          const wasWaiting = entry.state === "waiting";
          entry.state = "cancelled";
          if (wasWaiting) {
            const index = this.queue.indexOf(entry);
            if (index !== -1) this.queue.splice(index, 1);
          }
          cleanup();
          // All state changes precede abort dispatch: consumers may synchronously
          // release, acquire, or close from this signal's listeners.
          if (wasWaiting) resolve(reason);
          controller.abort(reason);
        },
        grant: () => {
          entry.state = "active";
          this.active = entry;
          resolve({
            success: true,
            lease: {
              context,
              signal: controller.signal,
              check: entry.check,
              release: () => {
                if (entry.state === "released") return;
                entry.state = "released";
                cleanup();
                if (this.active !== entry) return;
                this.active = undefined;
                this.drain();
              },
            },
          });
        },
      };
      const armDeadline = () => {
        if (deadline === undefined || entry.failure || entry.state === "released") return;
        if (entry.check()) return;
        // Chunk long deadlines rather than letting Node clamp overflowing delays to 1ms.
        disposeTimer = this.clock.schedule(
          () => {
            disposeTimer = undefined;
            armDeadline();
          },
          Math.min(MAX_TIMER_MS, Math.max(1, deadline - this.clock.now())),
        );
      };
      this.queue.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Also handles an abort/deadline between initial validation and registration.
      if (!entry.check()) armDeadline();
      this.drain();
    });
  }

  /** Synchronously deny new requests and cancel all handles; never free an active lease. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const entry of [...this.queue]) entry.cancel(closed());
    this.active?.cancel(closed());
  }

  private drain(): void {
    while (!this.isClosed && !this.active && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (entry && !entry.check()) entry.grant();
    }
  }
}
