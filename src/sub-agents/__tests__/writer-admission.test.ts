import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import {
  MAX_WAITING_WRITERS,
  type WriterAdmissionClock,
  WriterAdmissionController,
  type WriterAdmissionResult,
} from "../writer-admission.js";

class FakeClock implements WriterAdmissionClock {
  time = 0;
  private nextId = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  scheduled = 0;
  disposed = 0;
  fired = 0;

  now(): number {
    return this.time;
  }

  schedule(callback: () => void, delayMs: number): () => void {
    assert.ok(delayMs > 0 && delayMs <= 2_147_483_647);
    const id = this.nextId++;
    this.scheduled++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return () => {
      if (this.timers.delete(id)) this.disposed++;
    };
  }

  advanceTo(time: number): void {
    this.time = time;
    this.flush();
  }

  flush(): void {
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.time) {
        this.timers.delete(id);
        this.fired++;
        timer.callback();
      }
    }
  }

  assertClean(): void {
    assert.equal(this.timers.size, 0);
    assert.equal(this.scheduled, this.disposed + this.fired);
  }
}

function lease<T>(result: WriterAdmissionResult<T>) {
  assert.equal(result.success, true);
  if (!result.success) throw new Error("Expected lease");
  return result.lease;
}

function refused<T>(result: WriterAdmissionResult<T>, kind: "failed" | "cancelled" | "timed_out") {
  assert.equal(result.success, false);
  if (result.success) throw new Error("Expected refusal");
  assert.equal(result.failureKind, kind);
  assert.ok(result.details.length < 160);
  return result;
}

function listeners(controller: AbortController): number {
  return getEventListeners(controller.signal, "abort").length;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const clock = new FakeClock();
  const admission = new WriterAdmissionController<number>(clock);
  return { clock, admission };
}

describe("WriterAdmissionController", () => {
  it("keeps FIFO request order and one live owner until deferred settlement", async () => {
    const { clock, admission } = fixture();
    const first = lease(await admission.acquire({ context: 0, deadline: 100 }));
    const settled = deferred();
    const releaseAtSettlement = settled.promise.then(() => first.release());
    const order: number[] = [];
    let active = 1;
    const waiting = [1, 2, 3].map((context) =>
      admission.acquire({ context, deadline: 100 }).then((result) => {
        const next = lease(result);
        assert.equal(active, 0);
        active++;
        order.push(next.context);
        assert.equal(next.check(), undefined);
        active--;
        next.release();
      }),
    );
    await Promise.resolve();
    assert.deepEqual(order, []);
    assert.equal(admission.waitingCount, 3);
    active--;
    settled.resolve();
    await releaseAtSettlement;
    await Promise.all(waiting);
    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(admission.hasActiveLease, false);
    assert.equal(admission.waitingCount, 0);
    clock.assertClean();
  });

  it("admits exactly 100 waiters, rejects overflow without handles, and reuses a removed slot", async () => {
    const { clock, admission } = fixture();
    const first = lease(await admission.acquire({ context: -1 }));
    const controllers = Array.from({ length: MAX_WAITING_WRITERS }, () => new AbortController());
    const waiting = controllers.map((controller, context) =>
      admission.acquire({ context, signal: controller.signal, deadline: 100 }),
    );
    const overflowSignal = new AbortController();
    const overflow = refused(
      await admission.acquire({ context: 100, signal: overflowSignal.signal, deadline: 100 }),
      "failed",
    );
    assert.match(overflow.details, /busy.*100.*wait.*settle/);
    assert.equal(admission.waitingCount, 100);
    assert.equal(clock.timers.size, 100);
    assert.equal(listeners(overflowSignal), 0);
    controllers[50].abort("sensitive reason must not leak");
    refused(await waiting[50], "cancelled");
    const replacement = admission.acquire({ context: 101, deadline: 100 });
    assert.equal(admission.waitingCount, 100);
    first.release();
    const order: number[] = [];
    for (const pending of [...waiting, replacement]) {
      const result = await pending;
      if (result.success) {
        order.push(result.lease.context);
        result.lease.release();
      }
    }
    assert.deepEqual(order, [
      ...Array.from({ length: 100 }, (_, i) => i).filter((i) => i !== 50),
      101,
    ]);
    assert.ok(controllers.every((controller) => listeners(controller) === 0));
    clock.assertClean();
  });

  it("removes aborted head, middle, and tail waiters without granting them", async () => {
    for (const index of [0, 1, 2]) {
      const { clock, admission } = fixture();
      const first = lease(await admission.acquire({ context: -1 }));
      const controllers = [new AbortController(), new AbortController(), new AbortController()];
      const waiting = controllers.map((controller, context) =>
        admission.acquire({ context, signal: controller.signal, deadline: 100 }),
      );
      controllers[index].abort();
      refused(await waiting[index], "cancelled");
      assert.equal(admission.waitingCount, 2);
      assert.equal(clock.timers.size, 2);
      first.release();
      for (let i = 0; i < waiting.length; i++) {
        const result = await waiting[i];
        if (i === index) refused(result, "cancelled");
        else lease(result).release();
      }
      assert.ok(controllers.every((controller) => listeners(controller) === 0));
      clock.assertClean();
    }
  });

  it("rejects pre-aborted, expired, and nonfinite deadlines without allocating handles", async () => {
    const { clock, admission } = fixture();
    const aborted = new AbortController();
    aborted.abort("private");
    assert.doesNotMatch(
      refused(await admission.acquire({ context: 1, signal: aborted.signal }), "cancelled").details,
      /private/,
    );
    for (const deadline of [-1, 0]) {
      refused(await admission.acquire({ context: 1, deadline }), "timed_out");
    }
    for (const deadline of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      refused(await admission.acquire({ context: 1, deadline }), "failed");
    }
    assert.equal(listeners(aborted), 0);
    assert.equal(admission.hasActiveLease, false);
    assert.equal(admission.waitingCount, 0);
    assert.equal(clock.scheduled, 0);
  });

  it("rechecks cancellation and deadline after initial validation before admission", async () => {
    for (const cause of ["abort", "deadline"] as const) {
      const { clock, admission } = fixture();
      const controller = new AbortController();
      let reads = 0;
      clock.now = () => {
        reads++;
        if (reads === 1) {
          // The initial deadline read occurs after the initial signal check.
          if (cause === "abort") controller.abort();
          else clock.time = 10;
          return 0;
        }
        return clock.time;
      };
      refused(
        await admission.acquire({ context: 0, signal: controller.signal, deadline: 10 }),
        cause === "abort" ? "cancelled" : "timed_out",
      );
      assert.equal(admission.hasActiveLease, false);
      assert.equal(admission.waitingCount, 0);
      assert.equal(listeners(controller), 0);
      clock.assertClean();
    }
  });

  it("expires waiters exactly at their deadlines and removes their listeners", async () => {
    const { clock, admission } = fixture();
    const first = lease(await admission.acquire({ context: 0 }));
    const signal = new AbortController();
    const expires = admission.acquire({ context: 1, deadline: 10, signal: signal.signal });
    const survives = admission.acquire({ context: 2, deadline: 20 });
    clock.advanceTo(9);
    assert.equal(admission.waitingCount, 2);
    clock.advanceTo(10);
    refused(await expires, "timed_out");
    assert.equal(listeners(signal), 0);
    assert.equal(admission.waitingCount, 1);
    first.release();
    lease(await survives).release();
    clock.assertClean();
  });

  it("rechecks deadlines on grant even when the timer has not run", async () => {
    const { clock, admission } = fixture();
    const first = lease(await admission.acquire({ context: 0 }));
    const expires = admission.acquire({ context: 1, deadline: 10 });
    const survives = admission.acquire({ context: 2, deadline: 20 });
    clock.time = 10;
    first.release();
    refused(await expires, "timed_out");
    const next = lease(await survives);
    assert.equal(next.context, 2);
    next.release();
    clock.assertClean();
  });

  it("abort before grant denies a lease; abort after grant denies usable launch authority", async () => {
    for (const abortBeforeGrant of [true, false]) {
      const { clock, admission } = fixture();
      const first = lease(await admission.acquire({ context: 0 }));
      const controller = new AbortController();
      const pending = admission.acquire({ context: 1, signal: controller.signal, deadline: 100 });
      if (abortBeforeGrant) controller.abort();
      first.release();
      if (!abortBeforeGrant) controller.abort();
      const result = await pending;
      if (abortBeforeGrant) {
        refused(result, "cancelled");
        assert.equal(admission.hasActiveLease, false);
      } else {
        const granted = lease(result);
        assert.equal(granted.signal.aborted, true);
        assert.equal(granted.check()?.failureKind, "cancelled");
        assert.equal(admission.hasActiveLease, true);
        granted.release();
      }
      assert.equal(listeners(controller), 0);
      clock.assertClean();
    }
  });

  it("pre-spawn check observes a post-grant deadline without waiting for a timer", async () => {
    const { clock, admission } = fixture();
    const controller = new AbortController();
    const pending = admission.acquire({ context: 0, signal: controller.signal, deadline: 10 });
    clock.time = 10;
    const granted = lease(await pending);
    assert.equal(granted.check()?.failureKind, "timed_out");
    assert.equal(granted.signal.aborted, true);
    assert.equal(admission.hasActiveLease, true);
    assert.equal(listeners(controller), 0);
    granted.release();
    clock.assertClean();
  });

  it("active abort and timeout retain capacity until the owning settlement releases", async () => {
    for (const cause of ["abort", "timeout"] as const) {
      const { clock, admission } = fixture();
      const controller = new AbortController();
      const first = lease(
        await admission.acquire({ context: 0, signal: controller.signal, deadline: 10 }),
      );
      const settlement = deferred();
      const owner = settlement.promise.finally(() => first.release());
      const pending = admission.acquire({ context: 1 });
      let nextGranted = false;
      void pending.then(() => {
        nextGranted = true;
      });
      if (cause === "abort") controller.abort();
      else clock.advanceTo(10);
      await Promise.resolve();
      assert.equal(nextGranted, false);
      assert.equal(admission.waitingCount, 1);
      assert.equal(admission.hasActiveLease, true);
      assert.equal(first.check()?.failureKind, cause === "abort" ? "cancelled" : "timed_out");
      assert.equal(listeners(controller), 0);
      clock.assertClean();
      settlement.resolve();
      await owner;
      lease(await pending).release();
      assert.equal(admission.hasActiveLease, false);
    }
  });

  it("an expired pre-spawn check permits reentrant settlement without releasing the next owner", async () => {
    const { clock, admission } = fixture();
    const first = lease(await admission.acquire({ context: 0, deadline: 10 }));
    const nextPending = admission.acquire({ context: 1, deadline: 100 });
    first.signal.addEventListener("abort", () => first.release());
    clock.time = 10;
    assert.equal(first.check()?.failureKind, "timed_out");
    const next = lease(await nextPending);
    first.release();
    assert.equal(next.check(), undefined);
    assert.equal(admission.hasActiveLease, true);
    next.release();
    clock.assertClean();
  });

  it("close synchronously cancels queued and active handles but retains the active lease", async () => {
    const { clock, admission } = fixture();
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const first = lease(
      await admission.acquire({ context: 0, signal: controllers[0].signal, deadline: 100 }),
    );
    const waiting = controllers
      .slice(1)
      .map((controller, context) =>
        admission.acquire({ context, signal: controller.signal, deadline: 100 }),
      );
    admission.close();
    admission.close();
    assert.equal(first.signal.aborted, true);
    assert.equal(first.check()?.failureKind, "cancelled");
    assert.equal(admission.hasActiveLease, true);
    assert.equal(admission.waitingCount, 0);
    assert.ok(controllers.every((controller) => listeners(controller) === 0));
    clock.assertClean();
    for (const pending of waiting) refused(await pending, "cancelled");
    const denied = new AbortController();
    refused(
      await admission.acquire({ context: 3, signal: denied.signal, deadline: 100 }),
      "cancelled",
    );
    assert.equal(listeners(denied), 0);
    first.release();
    assert.equal(admission.hasActiveLease, false);
    refused(await admission.acquire({ context: 4 }), "cancelled");
  });

  it("close before the first acquisition refuses without allocating handles", async () => {
    const { clock, admission } = fixture();
    admission.close();
    refused(await admission.acquire({ context: 1, deadline: 10 }), "cancelled");
    assert.equal(admission.hasActiveLease, false);
    assert.equal(clock.scheduled, 0);
  });

  it("a close between grant and continuation revokes pre-spawn authority", async () => {
    const { clock, admission } = fixture();
    const pending = admission.acquire({ context: 0, deadline: 100 });
    admission.close();
    const granted = lease(await pending);
    assert.equal(granted.check()?.failureKind, "cancelled");
    assert.equal(granted.signal.aborted, true);
    granted.release();
    clock.assertClean();
  });

  it("idempotent and stale release cannot free a different owner", async () => {
    const { clock, admission } = fixture();
    const first = lease(await admission.acquire({ context: 0, deadline: 100 }));
    const secondPending = admission.acquire({ context: 1, deadline: 100 });
    const thirdPending = admission.acquire({ context: 2, deadline: 100 });
    first.release();
    first.release();
    const second = lease(await secondPending);
    assert.equal(first.check()?.failureKind, "failed");
    assert.equal(admission.hasActiveLease, true);
    assert.equal(admission.waitingCount, 1);
    first.release();
    assert.equal(second.check(), undefined);
    assert.equal(clock.timers.size, 2);
    second.release();
    second.release();
    const third = lease(await thirdPending);
    assert.equal(third.check(), undefined);
    third.release();
    third.release();
    assert.equal(admission.hasActiveLease, false);
    clock.assertClean();
  });

  it("abort listener reentrancy can release and enqueue without overtaking existing waiters", async () => {
    const { clock, admission } = fixture();
    const controller = new AbortController();
    const first = lease(
      await admission.acquire({ context: 0, signal: controller.signal, deadline: 100 }),
    );
    const secondPending = admission.acquire({ context: 1, deadline: 100 });
    let thirdPending: Promise<WriterAdmissionResult<number>> | undefined;
    first.signal.addEventListener("abort", () => {
      assert.equal(listeners(controller), 0);
      assert.equal(clock.timers.size, 1);
      thirdPending = admission.acquire({ context: 2, deadline: 100 });
      first.release();
      first.release();
    });
    controller.abort();
    const second = lease(await secondPending);
    assert.equal(second.context, 1);
    assert.equal(admission.waitingCount, 1);
    assert.ok(thirdPending);
    second.release();
    const third = lease(await thirdPending);
    assert.equal(third.context, 2);
    third.release();
    clock.assertClean();
  });

  it("close is safe when active abort listeners release, close again, and acquire", async () => {
    const { clock, admission } = fixture();
    const first = lease(await admission.acquire({ context: 0, deadline: 100 }));
    const waiting = admission.acquire({ context: 1, deadline: 100 });
    let reentrant: Promise<WriterAdmissionResult<number>> | undefined;
    first.signal.addEventListener("abort", () => {
      assert.equal(admission.waitingCount, 0);
      clock.assertClean();
      first.release();
      admission.close();
      reentrant = admission.acquire({ context: 2, deadline: 100 });
    });
    admission.close();
    refused(await waiting, "cancelled");
    assert.ok(reentrant);
    refused(await reentrant, "cancelled");
    assert.equal(admission.hasActiveLease, false);
    clock.assertClean();
  });

  it("an external earlier abort listener cannot race a cancelled waiter into a usable grant", async () => {
    const { clock, admission } = fixture();
    const first = lease(await admission.acquire({ context: 0 }));
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => first.release(), { once: true });
    const waiting = admission.acquire({ context: 1, signal: controller.signal, deadline: 100 });
    controller.abort();
    refused(await waiting, "cancelled");
    assert.equal(admission.hasActiveLease, false);
    assert.equal(admission.waitingCount, 0);
    assert.equal(listeners(controller), 0);
    clock.assertClean();
  });

  it("preserves the first cancellation classification across competing terminal notifications", async () => {
    for (const firstCause of ["abort", "timeout", "close"] as const) {
      const { clock, admission } = fixture();
      const controller = new AbortController();
      const first = lease(
        await admission.acquire({ context: 0, signal: controller.signal, deadline: 10 }),
      );
      if (firstCause === "abort") controller.abort();
      else if (firstCause === "timeout") clock.advanceTo(10);
      else admission.close();
      const original = first.check();
      controller.abort();
      clock.advanceTo(20);
      admission.close();
      assert.equal(first.check(), original);
      assert.equal(first.signal.reason, original);
      assert.equal(original?.failureKind, firstCause === "timeout" ? "timed_out" : "cancelled");
      first.release();
      assert.equal(listeners(controller), 0);
      clock.assertClean();
    }
  });

  it("cleans successful-release handles and ignores stale timer callbacks", async () => {
    const { clock, admission } = fixture();
    const controller = new AbortController();
    const first = lease(
      await admission.acquire({ context: 0, signal: controller.signal, deadline: 100 }),
    );
    const stale = [...clock.timers.values()][0].callback;
    first.release();
    assert.equal(listeners(controller), 0);
    const second = lease(await admission.acquire({ context: 1, deadline: 200 }));
    controller.abort();
    clock.time = 100;
    stale();
    assert.equal(first.signal.aborted, false);
    assert.equal(second.check(), undefined);
    assert.equal(admission.hasActiveLease, true);
    assert.equal(clock.timers.size, 1);
    second.release();
    clock.assertClean();
  });

  it("chunks long deadlines and re-arms early callbacks without premature cancellation", async () => {
    const { clock, admission } = fixture();
    const deadline = 2_147_483_647 + 50;
    const first = lease(await admission.acquire({ context: 0, deadline }));
    clock.advanceTo(2_147_483_647);
    assert.equal(first.check(), undefined);
    assert.equal(clock.timers.size, 1);
    // A clock adjustment can make a scheduled callback arrive before the deadline.
    const [id, timer] = [...clock.timers][0];
    clock.timers.delete(id);
    clock.fired++;
    timer.callback();
    assert.equal(first.signal.aborted, false);
    assert.equal(clock.timers.size, 1);
    clock.advanceTo(deadline);
    assert.equal(first.check()?.failureKind, "timed_out");
    first.release();
    clock.assertClean();
  });

  it("retains invocation-local context and snapshots deadline and cancellation handles", async () => {
    const clock = new FakeClock();
    const admission = new WriterAdmissionController<{ cwd: string; name: string }>(clock);
    const first = lease(await admission.acquire({ context: { cwd: "/a", name: "one" } }));
    const originalSignal = new AbortController();
    const request = {
      context: { cwd: "/b", name: "two" },
      deadline: 10,
      signal: originalSignal.signal,
    };
    const pending = admission.acquire(request);
    request.deadline = 100;
    request.signal = new AbortController().signal;
    first.release();
    const second = lease(await pending);
    assert.equal(second.context, request.context);
    clock.advanceTo(10);
    assert.equal(second.check()?.failureKind, "timed_out");
    assert.equal(listeners(originalSignal), 0);
    second.release();
    clock.assertClean();
  });
});
