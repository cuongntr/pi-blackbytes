import { z } from "zod";

export const BlackbytesConfigSchema = z
  .object({
    disabled_tools: z.array(z.string()).default([]),
    disabled_sub_agents: z.array(z.string()).default([]),
    hashline_edit: z.boolean().default(true),
    copilot_initiator_header: z.boolean().default(true),
    websearch: z
      .object({
        provider: z.enum(["exa", "tavily"]).default("exa"),
        exa_api_key: z.string().optional(),
        tavily_api_key: z.string().optional(),
      })
      .optional(),
    context7: z
      .object({
        api_key: z.string().optional(),
      })
      .optional(),
    system_prompt_log: z
      .object({
        enabled: z.boolean().default(false),
        path: z.string().min(1, "path must be non-empty").optional(),
        capture_agent_start: z.boolean().default(true),
        capture_provider_system: z.boolean().default(false),
        include_nested: z.boolean().default(false),
        dedupe: z.boolean().default(true),
      })
      .optional(),
    sub_agents: z
      .record(
        z.string(),
        z
          .object({
            model: z.string().optional(),
            reasoningEffort: z.string().optional(),
            timeoutMs: z
              .number()
              .int("timeoutMs must be an integer")
              .positive("timeoutMs must be positive")
              .max(3_600_000, "timeoutMs must not exceed 3600000 (1 hour)")
              .optional(),
            fallbackModels: z
              .array(z.string().min(1, "fallbackModels entries must be non-empty strings"))
              .max(5, "fallbackModels must not exceed 5 entries")
              .refine((arr) => new Set(arr).size === arr.length, {
                message: "fallbackModels must not contain duplicate entries",
              })
              .optional(),
            executionMode: z.enum(["sequential", "parallel"]).optional(),
            // RESERVED / UNSUPPORTED
            // ----------------------
            // The nested Pi CLI does not currently accept a `--temperature` flag
            // (see PI_CLI_COMPATIBILITY_EVIDENCE in src/sub-agents/__tests__/runner.test.ts).
            // We accept and preserve `temperature` here so existing user settings
            // do not throw, but it is intentionally NOT threaded through to the runner.
            // `/blackbytes-status` surfaces any configured value as reserved/unsupported.
            temperature: z.number().optional(),
            promptMode: z.enum(["static", "append"]).optional(),
          })
          // Preserve any additional, currently-unknown per-agent fields so we
          // never silently strip user config. New runtime-supported fields can
          // be promoted to typed properties later without breaking forward-
          // compatible config files.
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type BlackbytesConfig = z.infer<typeof BlackbytesConfigSchema>;

export function parseBlackbytesConfig(
  input: unknown,
): { ok: true; value: BlackbytesConfig } | { ok: false; errors: string[] } {
  const result = BlackbytesConfigSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
  return { ok: false, errors };
}
