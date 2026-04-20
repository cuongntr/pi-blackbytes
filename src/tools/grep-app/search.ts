import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type HttpFetchOptions, httpFetch } from "../_shared/http.js";
import { registerTool } from "../_shared/register-tool.js";

const TOOL_NAME = "grep_app_search_github";

export interface GrepAppParams {
  query: string;
  language?: string[];
  matchCase?: boolean;
  matchWholeWords?: boolean;
  useRegexp?: boolean;
  repo?: string;
  path?: string;
}

export interface GrepAppHit {
  repo: { name: string };
  file: { name: string };
  lines: Record<string, string>;
}

export async function executeGrepAppSearch(
  params: GrepAppParams,
  fetchFn: (opts: HttpFetchOptions) => ReturnType<typeof httpFetch> = httpFetch,
): Promise<{ content: string }> {
  const {
    query,
    language,
    matchCase = false,
    matchWholeWords = false,
    useRegexp = false,
    repo,
    path,
  } = params;

  const url = new URL("https://grep.app/api/search");
  url.searchParams.set("q", query);

  if (matchCase) url.searchParams.set("case", "true");
  if (matchWholeWords) url.searchParams.set("words", "true");
  if (useRegexp) url.searchParams.set("regexp", "true");
  if (repo) url.searchParams.set("repo", repo);
  if (path) url.searchParams.set("path", path);
  if (language && language.length > 0) {
    for (const lang of language) {
      url.searchParams.append("lang[]", lang);
    }
  }

  const result = await fetchFn({ url: url.toString() });

  if (!result.ok) {
    return { content: `Error searching GitHub: ${result.error}` };
  }

  const data = result.data as Record<string, unknown>;

  // grep.app returns { hits: { hits: [...] }, ... }
  const hitsWrapper = data.hits as Record<string, unknown> | undefined;
  const hits: GrepAppHit[] = (hitsWrapper?.hits as GrepAppHit[]) ?? [];

  if (!Array.isArray(hits) || hits.length === 0) {
    return { content: `No results found for query: "${query}"` };
  }

  const parts: string[] = [
    `Search results for "${query}" on grep.app (${hits.length} results):`,
    "",
  ];

  for (const hit of hits.slice(0, 20)) {
    const repoName = hit.repo?.name ?? "unknown";
    const fileName = hit.file?.name ?? "unknown";
    parts.push(`### ${repoName} — ${fileName}`);

    const lines = hit.lines ?? {};
    const lineEntries = Object.entries(lines).sort(([a], [b]) => Number(a) - Number(b));

    for (const [lineNum, lineContent] of lineEntries) {
      parts.push(`  ${lineNum}: ${lineContent}`);
    }
    parts.push("");
  }

  return { content: parts.join("\n") };
}

export function registerGrepAppSearchTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAME, {
    name: TOOL_NAME,
    description:
      "Search code patterns across public GitHub repositories using grep.app. Returns matching code snippets with repo, file, and line number context. Use for finding real-world usage examples of APIs, libraries, or patterns.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Code pattern to search for (e.g. 'useState(', 'async function', 'import React from')",
      }),
      language: Type.Optional(
        Type.Array(Type.String(), {
          description: "Filter by programming language(s) (e.g. ['TypeScript', 'Python'])",
        }),
      ),
      matchCase: Type.Optional(
        Type.Boolean({ description: "Case-sensitive search (default: false)" }),
      ),
      matchWholeWords: Type.Optional(
        Type.Boolean({ description: "Match whole words only (default: false)" }),
      ),
      useRegexp: Type.Optional(
        Type.Boolean({
          description: "Interpret query as a regular expression (default: false)",
        }),
      ),
      repo: Type.Optional(
        Type.String({
          description: "Filter by repository (e.g. 'facebook/react', 'vercel/')",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "Filter by file path (e.g. 'src/components', 'route.ts')",
        }),
      ),
    }),
    execute: (params: GrepAppParams) => executeGrepAppSearch(params),
  });
}
