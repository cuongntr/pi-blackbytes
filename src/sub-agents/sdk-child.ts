import { closeSync, writeSync } from "node:fs";
import { encodeChildEvent, readLaunchEnvelope } from "./sdk-child-protocol.js";
import { type AiBinding, type SdkBinding, runSdkChildProvider } from "./sdk-child-provider.js";

// Separately bundled entry: never imported by the registered extension or ordinary tests.
async function main(): Promise<void> {
  let exitCode = 1;
  const deadline = Number(process.argv[2]);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGTERM", cancel).on("SIGINT", cancel);
  let terminalAttempted = false;
  let closed = false;
  let importing = false;
  const write = (frame: Buffer) => {
    if (JSON.parse(frame.toString("utf8")).type === "terminal") terminalAttempted = true;
    // One bounded frame at a time: no unbounded Writable queue under pipe backpressure.
    // A blocked write remains subject to parent TERM/KILL and its unchanged drain cap.
    let offset = 0;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (offset < frame.length) {
      if (Date.now() >= deadline) throw new Error("deadline");
      try {
        const written = writeSync(3, frame, offset, frame.length - offset);
        offset += written;
        if (!written) Atomics.wait(pause, 0, 0, 2);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EAGAIN" && code !== "EINTR") throw error;
        Atomics.wait(pause, 0, 0, 2);
      }
    }
  };
  try {
    const envelope = await readLaunchEnvelope(process.stdin, deadline);
    if (
      process.env.PI_AGENT_DIR !== envelope.agentDir ||
      process.env.PI_CODING_AGENT_DIR !== envelope.agentDir
    )
      throw new Error("setup");
    const localDeadline = Math.min(deadline, Date.now() + envelope.remainingMs);
    importing = true;
    const sdkRoot = import.meta.resolve("@earendil-works/pi-coding-agent");
    // The explicit Node flag enables the public resolver's parent URL argument.
    // Import-only exports work; pi-ai binds to THIS SDK installation, never BB's own copy.
    const aiRoot = import.meta.resolve("@earendil-works/pi-ai", sdkRoot);
    const sdk: SdkBinding = await import(sdkRoot);
    const ai: AiBinding = await import(aiRoot);
    importing = false;
    const terminal = await runSdkChildProvider(
      envelope,
      sdk,
      ai,
      {
        write,
        async flush() {
          closeSync(3);
          closed = true;
        },
      },
      controller.signal,
      localDeadline,
    );
    exitCode = terminal.outcome === "success" ? 0 : 1;
  } catch {
    // Reserved entry-import exit code, interpreted structurally by the parent, not stderr.
    if (importing) exitCode = 78;
    else if (!terminalAttempted && !closed) {
      try {
        write(
          encodeChildEvent({
            version: 1,
            type: "terminal",
            outcome: "failure",
            refusalLatched: false,
            failureKind: "failed",
            code: "protocol_initialization",
            settlement: { gateClosed: true, runsIdle: false, runtimeDisposed: false },
          }),
        );
      } catch {
        /* Broken protocol pipe cannot support another terminal. */
      }
    }
  } finally {
    process.off("SIGTERM", cancel).off("SIGINT", cancel);
    if (!closed) {
      try {
        closeSync(3);
      } catch {
        exitCode = exitCode || 1;
      }
    }
  }
  // Disposal/flush have settled; trusted extension timers cannot retain launch authority.
  process.exit(exitCode);
}
void main();
