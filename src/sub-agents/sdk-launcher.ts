import { type ChildProcess, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../shared/redact.js";
import { MAX_ARTIFACT_BYTES, captureArtifact } from "./artifacts.js";
import { boundReturnContent } from "./runner.js";
import {
  type ChildEvent,
  ChildEventDecoder,
  type ChildTerminal,
  type LaunchEnvelope,
  type ManagedSettlement,
  encodeLaunchEnvelope,
  isManagedProcessSuccess,
} from "./sdk-child-protocol.js";
import type { DelegateFailureKind, DelegateResult } from "./types.js";

export function sdkChildEnvironment(
  home: string,
  sdkVersion: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "SHELL", "TERM", "NODE_ENV"]) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  Object.assign(env, {
    PI_AGENT_DIR: home,
    PI_CODING_AGENT_DIR: home,
    PI_NESTED_DEPTH: "1",
    PI_CODING_AGENT: "true",
  });
  const [major, minor] = sdkVersion.split(".").map(Number);
  if (major > 0 || minor >= 85) env.AI_AGENT = "pi";
  return env;
}
export interface ManagedLaunchOptions {
  envelope: LaunchEnvelope;
  /** Original execute-entry deadline. No await/queue/fallback renews this authority. */
  deadline: number;
  signal?: AbortSignal;
  onEvent?: (event: ChildEvent) => void;
  captureArtifacts?: boolean;
  artifactAgent?: string;
}
export interface ManagedLaunchResult extends DelegateResult {
  settlement?: ManagedSettlement;
}
export interface LauncherDependencies {
  spawn: typeof spawn;
  nestedDepth: () => number;
  entry: string;
  expectedVersion: () => Promise<string>;
  access: typeof access;
  signalChild: (child: ChildProcess, signal: NodeJS.Signals) => void;
}
const production: LauncherDependencies = {
  nestedDepth: () => Number(process.env.PI_NESTED_DEPTH ?? 0),
  spawn,
  access,
  entry: fileURLToPath(new URL("./sdk-child.js", import.meta.url)),
  expectedVersion: async () =>
    (await import(import.meta.resolve("@earendil-works/pi-coding-agent"))).VERSION as string,
  signalChild(child, signal) {
    try {
      if (process.platform === "linux" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* Already closed, or termination cannot be proven: drain still owns settlement. */
    }
  },
};

/** Unadopted producer. No CLI fallback, registry selection, retries, writer release or registration. */
export async function launchManagedSdkChild(
  options: ManagedLaunchOptions,
  deps = production,
): Promise<ManagedLaunchResult> {
  // Copy before first await; no caller mutation can change the admitted intent.
  let envelope: LaunchEnvelope;
  try {
    envelope = structuredClone(options.envelope);
  } catch {
    return { success: false, failureKind: "failed", content: "Managed child refused: failed" };
  }
  const { deadline, signal, onEvent, captureArtifacts, artifactAgent } = options;
  const startedAt = Date.now();
  let artifactOutput = "";
  let totalOutputChars = 0;
  const authorityFailure = (): DelegateFailureKind | undefined =>
    signal?.aborted ? "cancelled" : Date.now() >= deadline ? "timed_out" : undefined;
  const refused = (failureKind: DelegateFailureKind): ManagedLaunchResult => ({
    success: false,
    failureKind,
    content: `Managed child refused: ${failureKind}`,
  });
  if (deps.nestedDepth() >= 1) return refused("recursion_refused");
  if (!Number.isFinite(deadline)) return refused("timed_out");
  let stopped = authorityFailure();
  if (stopped) return refused(stopped);
  // A stalled import/access does not retain the parent invocation indefinitely. Promise
  // settlement after this race has no spawn authority and its rejection is observed.
  let preflightTimer: ReturnType<typeof setTimeout> | undefined;
  let preflightAbort: (() => void) | undefined;
  try {
    envelope.expectedSdkVersion = await Promise.race([
      (async () => {
        await deps.access(deps.entry);
        if (authorityFailure()) throw new Error("authority");
        return deps.expectedVersion();
      })(),
      new Promise<never>((_resolve, reject) => {
        preflightAbort = () => reject(new Error("cancelled"));
        signal?.addEventListener("abort", preflightAbort, { once: true });
        preflightTimer = setTimeout(
          () => reject(new Error("timed_out")),
          Math.max(0, deadline - Date.now()),
        );
        if (signal?.aborted) preflightAbort();
      }),
    ]);
  } catch {
    return refused(authorityFailure() ?? "spawn_error");
  } finally {
    clearTimeout(preflightTimer);
    if (preflightAbort) signal?.removeEventListener("abort", preflightAbort);
  }
  stopped = authorityFailure();
  if (stopped) return refused(stopped);
  envelope.remainingMs = Math.min(envelope.remainingMs, Math.floor(deadline - Date.now()));
  let setup: Buffer;
  try {
    setup = encodeLaunchEnvelope(envelope);
  } catch {
    return refused("failed");
  }
  stopped = authorityFailure();
  if (stopped) return refused(stopped);
  let child: ChildProcess;
  try {
    child = deps.spawn(
      process.execPath,
      ["--experimental-import-meta-resolve", deps.entry, String(deadline)],
      {
        cwd: envelope.cwd,
        env: sdkChildEnvironment(envelope.agentDir, envelope.expectedSdkVersion),
        detached: process.platform === "linux",
        shell: false,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      },
    );
  } catch {
    return refused("spawn_error");
  }
  const result = await new Promise<ManagedLaunchResult>((resolve) => {
    const decoder = new ChildEventDecoder();
    let terminal: ChildTerminal | undefined;
    let protocolEof = false;
    let protocolValid = true;
    let closeObserved = false;
    let done = false;
    let terminationStarted = false;
    let eventCallbackEnabled = true;
    let outputHead = "";
    let outputTail = "";
    let output = "";
    let failure: DelegateFailureKind | undefined;
    let cancellation: "cancelled" | "timed_out" | "killed" | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const pipe = child.stdio[3] as Readable | null;
    const finish = (settlement: ManagedSettlement) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      signal?.removeEventListener("abort", cancel);
      // Late close must not mutate returned reaped:false evidence. Continue draining, no callbacks.
      const success = !failure && !cancellation && isManagedProcessSuccess(settlement);
      const kind =
        cancellation ??
        failure ??
        (terminal?.outcome === "failure" ? terminal.failureKind : "failed");
      resolve({
        success,
        settlement,
        ...(success ? {} : { failureKind: kind }),
        content: success
          ? output
          : kind === "provider_or_model_unavailable"
            ? "Model unavailable in selected agent home. Load provider resources there and restart Pi."
            : `Managed child refused: ${kind}`,
      });
    };
    const terminate = (reason: "cancelled" | "timed_out" | "killed", preserveFailure = false) => {
      if (done || terminationStarted) return;
      terminationStarted = true;
      if (!preserveFailure) cancellation = reason;
      deps.signalChild(child, "SIGTERM");
      killTimer = setTimeout(() => {
        if (!closeObserved) deps.signalChild(child, "SIGKILL");
      }, 100);
      drainTimer = setTimeout(
        () => finish({ reaped: false, childCloseObserved: false, reason, writerRetired: true }),
        5000,
      );
    };
    const cancel = () => terminate("cancelled");
    const timer = setTimeout(() => terminate("timed_out"), Math.max(0, deadline - Date.now()));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    // Arbitrary stdout/stderr are diagnostic-only. Discarding is stronger than retaining
    // a redacted tail: split secrets, prompts and registry dumps never enter metadata.
    child.stdout?.resume();
    child.stderr?.resume();
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    pipe?.on("data", (bytes: Buffer) => {
      if (done || !protocolValid) return;
      try {
        decoder.push(bytes, (event) => {
          if (event.type === "terminal") terminal = event;
          if (event.type === "delta" && event.channel === "output") {
            totalOutputChars += event.text.length;
            if (captureArtifacts && artifactOutput.length < MAX_ARTIFACT_BYTES) {
              artifactOutput += event.text.slice(0, MAX_ARTIFACT_BYTES - artifactOutput.length);
            }
            outputHead = (outputHead + event.text).slice(0, 24576);
            outputTail = (outputTail + event.text).slice(-24576);
            output =
              totalOutputChars <= 24576 ? outputHead : boundReturnContent(outputHead + outputTail);
          }
          if (eventCallbackEnabled) {
            try {
              onEvent?.(structuredClone(event));
            } catch {
              eventCallbackEnabled = false;
              failure = "failed";
              terminate("killed", true);
            }
          }
        });
      } catch {
        protocolValid = false;
        failure = "malformed_jsonl";
        terminate("killed", true);
      }
    });
    pipe?.once("end", () => {
      protocolEof = true;
      try {
        terminal = decoder.finish();
      } catch {
        protocolValid = false;
        failure = "malformed_jsonl";
      }
    });
    pipe?.on("error", () => {
      protocolValid = false;
      failure = "malformed_jsonl";
    });
    child.on("error", () => {
      failure = "spawn_error";
      terminate("killed", true);
    });
    child.once("exit", (_code, exitSignal) => {
      if (exitSignal && !cancellation) terminate("killed");
    });
    child.once("close", (exitCode, exitSignal) => {
      closeObserved = true;
      // Timers can be delayed behind I/O callbacks. Observed close after the original
      // deadline (or abort) cannot turn a late terminal into successful authority.
      const stopped = authorityFailure();
      if (stopped === "cancelled" || stopped === "timed_out") cancellation ??= stopped;
      if (exitCode === 78 && !terminal) failure = "spawn_error";
      if (!protocolEof || !terminal) {
        protocolValid = false;
        failure ??= "malformed_jsonl";
      }
      finish({
        reaped: true,
        childCloseObserved: true,
        protocolEof,
        protocolValid,
        exitCode,
        signal: exitSignal,
        ...(terminal ? { terminal } : {}),
      });
    });
    child.stdin?.on("error", () => {
      failure ??= "failed";
    });
    if (cancellation) child.stdin?.destroy();
    else child.stdin?.end(setup);
  });
  if (captureArtifacts && totalOutputChars > 24576) {
    try {
      const artifact = await captureArtifact({
        agent: redactSecrets(artifactAgent ?? "sub-agent").slice(0, 256),
        content: artifactOutput,
        startedAt,
        durationMs: Date.now() - startedAt,
        model: redactSecrets(`${envelope.model.provider}/${envelope.model.id}`).slice(0, 256),
        ...(result.failureKind ? { failureKind: result.failureKind } : {}),
      });
      if (artifact) result.artifactPath = artifact.path;
    } catch {
      /* Existing opt-in best-effort artifact policy; no raw diagnostics. */
    }
  }
  return result;
}
