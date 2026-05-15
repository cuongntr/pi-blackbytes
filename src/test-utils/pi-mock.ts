import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface MockPiCalls {
  registerTool: unknown[];
  registerCommand: unknown[];
  registerProvider: Array<{ name: string; opts: unknown }>;
  on: Array<{ event: string; handler: (...args: any[]) => unknown | Promise<unknown> }>;
  setActiveTools: unknown[][];
  appendEntry: unknown[];
}

export interface MockPi {
  registerTool(definition: unknown): void;
  registerCommand(name: string, options: unknown): void;
  registerProvider(name: string, opts: unknown): void;
  on(event: string, handler: (...args: any[]) => unknown | Promise<unknown>): void;
  setActiveTools(...args: unknown[]): void;
  appendEntry(...args: unknown[]): void;
  /** Recorded calls for assertions */
  calls: MockPiCalls;
  /** Trigger a registered event handler */
  emit(event: string, ...args: unknown[]): void | Promise<void>;
}

export function createMockPi(): MockPi & ExtensionAPI {
  const calls: MockPiCalls = {
    registerTool: [],
    registerCommand: [],
    registerProvider: [],
    on: [],
    setActiveTools: [],
    appendEntry: [],
  };

  const handlers = new Map<string, Array<(...args: any[]) => unknown | Promise<unknown>>>();

  // Default ctx supplied when tests emit events without an explicit ctx.
  // Mirrors what Pi's runtime always provides to handlers.
  const defaultCtx = {
    model: undefined as { id: string } | undefined,
    ui: {
      notify: () => {},
      input: async () => undefined as string | undefined,
      select: async () => undefined as string | undefined,
      confirm: async () => false,
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    },
  };

  const mock: MockPi = {
    calls,

    registerTool(definition: unknown): void {
      calls.registerTool.push(definition);
    },

    registerCommand(name: string, options: unknown): void {
      calls.registerCommand.push({ name, options });
    },

    registerProvider(name: string, opts: unknown): void {
      calls.registerProvider.push({ name, opts });
    },

    on(event: string, handler: (...args: any[]) => unknown | Promise<unknown>): void {
      calls.on.push({ event, handler });
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },

    setActiveTools(...args: unknown[]): void {
      calls.setActiveTools.push(args);
    },

    appendEntry(...args: unknown[]): void {
      calls.appendEntry.push(args);
    },

    async emit(event: string, ...args: unknown[]): Promise<void> {
      const list = handlers.get(event);
      if (!list || list.length === 0) return;
      // Pi runtime always passes (event, ctx); supply default ctx when not provided.
      // Run handlers sequentially so return-based hooks (notably before_agent_start)
      // can be chained like Pi's ExtensionRunner.
      const callArgs: unknown[] = args.length >= 2 ? args : [args[0], defaultCtx];
      for (const handler of list) {
        const result = await handler(...callArgs);
        if (event === "before_agent_start" && result && typeof result === "object") {
          const systemPrompt = (result as { systemPrompt?: unknown }).systemPrompt;
          const eventArg = callArgs[0];
          if (
            typeof systemPrompt === "string" &&
            eventArg &&
            typeof eventArg === "object" &&
            "systemPrompt" in eventArg
          ) {
            (eventArg as { systemPrompt: string }).systemPrompt = systemPrompt;
          }
        }
      }
    },
  };

  return mock as unknown as MockPi & ExtensionAPI;
}
