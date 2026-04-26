import type { BlackbytesConfig } from "../../config/schema.js";

export type WebProvider = "exa" | "tavily";

export interface ResolvedWebProviderConfig {
  provider: WebProvider;
  exaApiKey?: string;
  tavilyApiKey?: string;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value?.trim()) return value;
  }
  return undefined;
}

export function resolveWebProviderConfig(config: BlackbytesConfig): ResolvedWebProviderConfig {
  return {
    provider: config.websearch?.provider ?? "exa",
    exaApiKey: firstNonEmpty(config.websearch?.exa_api_key, process.env.EXA_API_KEY),
    tavilyApiKey: firstNonEmpty(config.websearch?.tavily_api_key, process.env.TAVILY_API_KEY),
  };
}

export function providerApiKey(config: ResolvedWebProviderConfig): string | undefined {
  return config.provider === "tavily" ? config.tavilyApiKey : config.exaApiKey;
}
