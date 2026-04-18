# PRD — `pi-blackbytes`

**Product:** `@blackbytes/pi-blackbytes` — một Pi coding agent extension port các tính năng của `oc-blackbytes` (OpenCode plugin) sang Pi (`@mariozechner/pi-coding-agent`).
**Owner:** blackbytes
**Target Pi version:** `@mariozechner/pi-coding-agent` ≥ 0.67.x
**Distribution:** npm package, cài qua `pi install npm:@blackbytes/pi-blackbytes` hoặc qua `settings.json › packages`.
**Status:** Draft v1

---

## 1. Background

### 1.1 oc-blackbytes (nguồn port)

`oc-blackbytes` là OpenCode plugin cung cấp:

| Tầng | Chi tiết |
|---|---|
| **Hooks** | `config`, `chat.headers`, `chat.params`, `tool`, `tool.execute.after` |
| **Agents** | `bytes` (primary, default_agent), `explore`, `oracle`, `librarian`, `general` — có prompt riêng theo model family (Claude / GPT / Gemini), language matching, permission map |
| **Tools** | `hashline_edit`, `ast_grep_search`, `ast_grep_replace`, `grep`, `glob` |
| **MCP servers** | `websearch` (Exa hoặc Tavily), `context7`, `grep_app` |
| **Commands** | `/setup-models` |
| **Post-processing** | Rewrite output `read` thành `LINE#ID\|content` anchors; normalize output `write` thành line-count summary |
| **Runtime adaptation** | Inject `x-initiator: agent` cho GitHub Copilot; chat.params map `reasoningEffort` → thinking/reasoning params đúng provider family |
| **Config** | JSONC `oc-blackbytes.json[c]`, Zod v4 schema, per-agent model overrides, model fallback chain |
| **Prompt injection** | Append `<available_resources>` block liệt kê tools/MCPs/peer agents enabled vào mọi agent prompt |

### 1.2 Pi coding agent (đích port)

Pi là AI coding CLI, **event-driven** (30+ events), **single-agent** theo mặc định, TypeScript/Node, cài qua npm (`@mariozechner/pi-coding-agent`). Primitives:

- **Extensions** (TS module exporting `default (pi: ExtensionAPI) => void`)
- **Skills** (Markdown SKILL.md, discoverable paths)
- **Settings** (`~/.pi/agent/settings.json`, JSON không comment)
- **Packages** (npm/git/local, filter skills/extensions/prompts/themes)
- **Commands / Shortcuts / Flags** (đăng ký runtime)
- **Tools** (đăng ký runtime qua `pi.registerTool`, schema bằng `@sinclair/typebox`)
- **UI** (`ctx.ui.select/confirm/input/notify/setStatus/setWidget/custom`)
- **State** (`pi.appendEntry`, `ctx.sessionManager`)

Khác biệt then chốt so OpenCode:

| Aspect | OpenCode | Pi |
|---|---|---|
| Agent model | Multi-agent với registry | **Single-agent** + optional nested sessions |
| MCP | First-class | **Không có** — triết lý là CLI tools + skills |
| Config | JSONC có comments | JSON thuần |
| Tool I/O interception | `tool.execute.after` | Events `tool_call` (trước), `tool_result` (sau) |
| System prompt | Per-agent static | Mutable per-turn qua `before_agent_start` |
| Per-agent overrides | Có | Không (chỉ 1 model active) |

### 1.3 Vì sao port

1. Nhiều dev muốn dùng workflow bytes (ngôn ngữ, hashline edit, oracle consultation) trong Pi.
2. Giữ parity tools (ast-grep, hashline, websearch) giữa 2 môi trường.
3. Tận dụng skill discovery + package distribution của Pi để phân phối cleaner hơn.

---

## 2. Goals

### 2.1 In scope (MVP)

| # | Tính năng oc-blackbytes | Cách port sang Pi | Mức độ parity |
|---|---|---|---|
| G1 | 5 agent personas (bytes, explore, oracle, librarian, general) | `bytes` là main agent prompt được inject toàn cục; 4 persona còn lại được expose thành custom tools `delegate_explore`, `delegate_oracle`, `delegate_librarian`, `delegate_general` — spawn Pi session con (`pi -p` / programmatic `AgentSession`) với system prompt riêng, model riêng, và tool set bị giới hạn theo từng persona. | 95% |
| G2 | 5 bundled tools (hashline_edit, ast_grep_search, ast_grep_replace, grep, glob) | Port 1:1 qua `pi.registerTool` — reuse code TypeScript hiện tại trong `src/extensions/tools/**`, chỉ đổi runtime adapter. | 100% |
| G3 | 3 MCPs (websearch Exa/Tavily, context7, grep_app) | Thành custom tools với **canonical names** dùng xuyên suốt plan và codebase: `websearch_search`, `websearch_fetch`, `context7_resolve_library_id`, `context7_query_docs`, `grep_app_search_github`. Gọi HTTP trực tiếp. | 100% functional parity |
| G4 | Hashline edit post-processing (`LINE#ID` trên read, line-count normalize trên write) | Subscribe `tool_result` với `event.toolName === "read"` / `"write"`, rewrite `content`. Opt-in qua setting `hashline_edit`. Default `true`. | 100% |
| G5 | `x-initiator: agent` header cho Copilot | Subscribe `before_provider_request`, detect provider là GitHub Copilot (qua `ctx.model.provider`), mutate payload headers. | 100% |
| G6 | chat.params model-family adaptation (reasoningEffort → thinking) | Subscribe `model_select` + `before_provider_request`. Map reasoning config theo model family hiện hành. | 90% — Pi có thể đã tự map một phần; chỉ can thiệp phần Pi chưa hỗ trợ. |
| G7 | `<available_resources>` prompt injection | Subscribe `before_agent_start`, append block liệt kê tools/skills enabled vào `systemPrompt`. | 100% |
| G8 | `/setup-models` command | Register `pi.registerCommand("setup-models", ...)` — TUI wizard dùng `ctx.ui.select/confirm/input` để viết settings. | 100% |
| G9 | Config loader + Zod validation | Dùng `settings.json` của Pi + block riêng `blackbytes: { ... }`. Validate bằng Zod v4 khi `session_start`. Cảnh báo qua `ctx.ui.notify`. | 100% |
| G10 | Language matching prompt block | Include trong system-prompt extra block của bytes + từng sub-agent prompt. | 100% |
| G11 | Built-in skills bundle | Phân phối kèm package: `skills/` với các SKILL.md tương ứng mỗi sub-agent (để LLM có thể tự tra thay vì luôn delegate). | 100% |
| G12 | Buffered file logger | Port 1:1 — log tới `/tmp/pi-blackbytes.log` hoặc `~/.pi/logs/pi-blackbytes.log`. | 100% |

### 2.2 Out of scope (MVP)

- **Supersede Pi built-in tools**: không replace Pi's `read`/`write`/`edit` bằng hashline-only. Chỉ intercept output.
- **Permission map**: Pi không có permission system, bỏ qua. Thay bằng gate `tool_call` với `ctx.ui.confirm` cho lệnh nguy hiểm (optional).
- **Model fallback chain** ở mức global (G10 trong oc-blackbytes): Pi có retry riêng; MVP không port. Đưa vào v2.
- **Beads integration**: ngoài scope — user tự dùng skills.
- **Theme**: không port (Pi có theme system riêng, không bundle mặc định).

### 2.3 Non-goals

- Không cố gắng làm `pi-blackbytes` thành drop-in replacement cho `bytes` agent native của Pi — nó là superset/override.
- Không tái tạo hook model của OpenCode 1:1 — dùng event model Pi.
- Không hỗ trợ JSONC cho settings (Pi không cho phép).

---

## 3. User Stories

1. **Dev đang dùng Pi muốn có hashline edit workflow.** Cài `pi-blackbytes` → tự động tools `hashline_edit` xuất hiện, output của `read` được rewrite thành `LINE#ID|content` → LLM có thể edit chính xác hơn.
2. **Dev muốn có oracle consultation.** Gọi tool `delegate_oracle` với câu hỏi → extension spawn Pi session với model reasoning cao + prompt oracle → trả về kết quả.
3. **Dev muốn context7 + websearch trong Pi.** Sau cài, tools `context7_*` và `websearch_*` khả dụng ngay nếu có API key trong settings.
4. **Dev chạy trên GitHub Copilot.** Extension tự thêm header `x-initiator: agent` không cần cấu hình.
5. **Lần đầu cài.** Chạy `/setup-models` → wizard hỏi provider, API keys, default model, recommended reasoning settings → ghi vào `~/.pi/agent/settings.json`.
6. **Tắt 1 tool.** Thêm `"disabled_tools": ["ast_grep_replace"]` trong block `blackbytes` của settings → tool không register.

---

## 4. Architecture

### 4.1 Package layout

```
pi-blackbytes/
├── package.json                   # name, pi field (entry points), deps
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                   # default export — ExtensionAPI entry
│   ├── bootstrap.ts               # Event subscriptions (analogue src/bootstrap.ts)
│   ├── config/
│   │   ├── loader.ts              # Read settings.json, extract "blackbytes" block
│   │   └── schema.ts              # Zod schemas (port từ oc-blackbytes)
│   ├── handlers/
│   │   ├── before-agent-start.ts  # <available_resources> injection
│   │   ├── before-provider-request.ts  # x-initiator header + thinking params
│   │   ├── tool-result.ts         # hashline rewrite cho read/write
│   │   └── model-select.ts        # track active model family
│   ├── tools/                     # ported 1:1 từ src/extensions/tools/**
│   │   ├── hashline-edit/
│   │   ├── ast-grep/
│   │   ├── grep/
│   │   ├── glob/
│   │   ├── websearch/             # Exa + Tavily custom tool
│   │   ├── context7/              # 2 tools: resolve + docs
│   │   └── grep-app/              # grep.app API tool
│   ├── sub-agents/                # delegate_* tools cho explore/oracle/librarian/general
│   │   ├── runner.ts              # spawn Pi session helper
│   │   ├── explore.ts
│   │   ├── oracle.ts
│   │   ├── librarian.ts
│   │   └── general.ts
│   ├── commands/
│   │   └── setup-models.ts        # /setup-models wizard
│   ├── prompts/                   # port prompts từ src/extensions/agents/**
│   │   ├── bytes/{default,gpt,gemini}.md
│   │   ├── explore.md
│   │   ├── oracle.md
│   │   ├── librarian.md
│   │   └── general.md
│   └── shared/
│       ├── logger.ts              # buffered file logger
│       └── model-capability.ts    # model family → reasoning param map
├── skills/                        # SKILL.md bundled
│   ├── blackbytes-overview/SKILL.md
│   ├── hashline-workflow/SKILL.md
│   └── delegation/SKILL.md
└── test/
    └── *.test.ts
```

### 4.2 Entry point (contract với Pi)

```typescript
// src/index.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { bootstrap } from "./bootstrap.js";

export default function (pi: ExtensionAPI) {
  bootstrap(pi);
}
```

```json
// package.json (trích)
{
  "name": "@blackbytes/pi-blackbytes",
  "version": "0.1.0",
  "pi": {
    "extensions": ["./dist/index.js"],
    "skills": ["./skills/**/SKILL.md"]
  },
  "dependencies": {
    "@mariozechner/pi-coding-agent": "^0.67",
    "@sinclair/typebox": "^0.33",
    "zod": "^4"
  }
}
```

### 4.3 Event subscriptions (mapping OpenCode hooks → Pi events)

| OpenCode hook | Pi replacement | Handler file |
|---|---|---|
| `config` (merge MCPs, agents, commands) | `session_start` + `resources_discover` (register tools + skills; load settings) | `bootstrap.ts` |
| `chat.headers` | `before_provider_request` | `handlers/before-provider-request.ts` |
| `chat.params` | `before_provider_request` + `model_select` | `handlers/before-provider-request.ts`, `handlers/model-select.ts` |
| `tool` (register bundled tools) | `pi.registerTool()` at bootstrap | `bootstrap.ts` |
| `tool.execute.after` (rewrite read/write) | `tool_result` | `handlers/tool-result.ts` |
| Agent prompt `<available_resources>` injection | `before_agent_start` | `handlers/before-agent-start.ts` |

### 4.4 Sub-agent delegation (G1)

`bytes` là main agent persona của extension; không expose thành delegate tool trong MVP. Mỗi sub-agent còn lại (`explore`, `oracle`, `librarian`, `general`) được expose thành 1 tool và chạy trong Pi session con với tool allowlist tương ứng, không chỉ dựa vào prompt instruction.

**Capability matrix cho nested sessions:**
- `delegate_explore`: read/search only; không write; không shell/command execution.
- `delegate_oracle`: read-only consultation; không write; không shell; chỉ dùng web/docs tools nếu được bật rõ ràng trong config.
- `delegate_librarian`: read/search/docs/web only; không write; không local command execution.
- `delegate_general`: full implementation agent; có thể write và dùng command/tool theo policy của session cha.

**Execution contract cho MVP:**
- Nested delegation bị giới hạn `maxDepth = 1`; sub-agent không được gọi tiếp `delegate_*` tools khác.
- Mỗi `delegate_*` tool phải có timeout mặc định, propagate cancellation từ session cha, và normalize mọi failure thành structured text result + machine-readable `details`.
- `cwd` kế thừa từ session cha; environment chỉ inherit allowlisted variables cần thiết cho provider/tool execution.
- Tool allowlist phải được enforce ở runtime, không chỉ qua prompt. Nếu execution path không enforce được allowlist thì path đó không được dùng cho persona tương ứng trong MVP.
- Streaming là optional; nếu unsupported phải buffer rồi trả 1 kết quả cuối cùng theo cùng output schema.

```typescript
// src/sub-agents/oracle.ts (pseudo)
pi.registerTool({
  name: "delegate_oracle",
  label: "Consult Oracle",
  description: "High-reasoning architecture/debugging consultation. Read-only.",
  parameters: Type.Object({
    question: Type.String({ description: "The question or problem" }),
    context: Type.Optional(Type.String())
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    const result = await runNestedPi({
      systemPrompt: ORACLE_PROMPT,
      userPrompt: buildPrompt(params),
      model: cfg.agents.oracle?.model ?? "openai/gpt-5.4",
      reasoningEffort: "high",
      allowedTools: buildAllowedToolsForPersona("oracle", cfg),
      cwd: ctx.cwd,
      signal,
      onUpdate,
    });
    return { content: [{ type: "text", text: result.text }], details: { tokens: result.tokens } };
  }
});
```

`runNestedPi` gọi `@mariozechner/pi-agent-core` API hoặc `execa` subprocess `pi -p --system-prompt-file ... --model ...`. Chọn programmatic nếu Pi export `AgentSession`; fallback subprocess. Kết quả M0 phải chốt chiến lược này trước khi vào milestone sub-agent.

### 4.5 Hashline post-processing (G4)

```typescript
// src/handlers/tool-result.ts
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

pi.on("tool_result", async (event, ctx) => {
  if (!cfg.hashline_edit) return;

  if (event.toolName === "read" && !event.isError) {
    const textBlock = event.content.find(c => c.type === "text");
    if (textBlock) {
      textBlock.text = rewriteWithHashlineAnchors(textBlock.text);
      return { content: event.content };
    }
  }

  if (event.toolName === "write" && !event.isError) {
    return {
      content: [{ type: "text", text: `File written successfully. ${lineCount} lines written.` }]
    };
  }
});
```

Edit tool của Pi: **không** rewrite output edit của Pi để tránh break. Cung cấp `hashline_edit` song song.

### 4.6 `<available_resources>` injection (G7)

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  const resources = buildAvailableResourcesBlock({
    tools: pi.getAllTools().map(t => t.name),
    skills: listEnabledSkills(ctx),
    subAgents: ["bytes", "explore", "oracle", "librarian", "general"]
  });
  return {
    systemPrompt: event.systemPrompt + "\n\n" + resources
  };
});
```

### 4.7 Config schema

```ts
// src/config/schema.ts — Zod v4, port từ oc-blackbytes
export const BlackbytesConfigSchema = z.object({
  disabled_tools: z.array(z.string()).optional(),
  disabled_sub_agents: z.array(z.enum(["explore","oracle","librarian","general"])).optional(),
  hashline_edit: z.boolean().default(true),
  copilot_initiator_header: z.boolean().default(true),
  websearch: z.object({
    provider: z.enum(["exa", "tavily"]).optional(),
    exa_api_key: z.string().optional(),
    tavily_api_key: z.string().optional(),
  }).optional(),
  context7: z.object({
    api_key: z.string().optional()
  }).optional(),
  sub_agents: z.record(z.string(), z.object({
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    temperature: z.number().optional(),
  })).optional(),
})
```

Đọc từ `~/.pi/agent/settings.json › blackbytes`:

```json
{
  "packages": ["npm:@blackbytes/pi-blackbytes@0.1.0"],
  "blackbytes": {
    "hashline_edit": true,
    "websearch": { "provider": "exa", "exa_api_key": "..." },
    "sub_agents": {
      "oracle": { "model": "openai/gpt-5.4", "reasoningEffort": "high" }
    }
  }
}
```

---

## 5. Detailed Requirements

### 5.1 Tools to register

Tool names trong bảng dưới đây là **public contract duy nhất của MVP**; prompts, skills, `<available_resources>`, docs, và tests phải dùng đúng các tên này.

| Tool name | Source | Notes |
|---|---|---|
| `hashline_edit` | Port `src/extensions/tools/hashline-edit/` | Dùng chung helper parse LINE#ID |
| `ast_grep_search` | Port `src/extensions/tools/ast-grep/` | Require `ast-grep` binary trong PATH |
| `ast_grep_replace` | Port trên | |
| `grep` | Port `src/extensions/tools/grep/` | Dùng ripgrep nếu có, fallback Node |
| `glob` | Port `src/extensions/tools/glob/` | `fast-glob` |
| `websearch_search` | New — gọi Exa `search` hoặc Tavily | Canonical name cho search parity |
| `websearch_fetch` | New — fetch URL | Canonical name cho fetch parity |
| `context7_resolve_library_id` | HTTP Context7 API | Canonical name dùng trong prompts/skills/tests |
| `context7_query_docs` | HTTP Context7 API | Canonical name dùng trong prompts/skills/tests |
| `grep_app_search_github` | HTTP grep.app API | Canonical name dùng trong prompts/skills/tests |
| `delegate_explore` | Sub-agent runner | Read/search only |
| `delegate_oracle` | Sub-agent runner | Read-only consultation |
| `delegate_librarian` | Sub-agent runner | Docs/web research only |
| `delegate_general` | Sub-agent runner | Full implementation agent |

Tất cả tools respect `disabled_tools` config.

**Activation semantics:**
- `disabled_tools` áp dụng cho bundled tools và HTTP tools theo exact public tool name.
- `disabled_sub_agents` áp dụng riêng cho `delegate_*` tools.
- `before_agent_start`, `resources_discover`, `/blackbytes-status`, và mọi capability listing khác phải dùng cùng một computed enabled-set; không được liệt kê resource đã bị disable.
- Nếu Pi không hỗ trợ unregister động, extension phải compute enabled-set tại `session_start` và chỉ expose/activate đúng tập đó cho toàn bộ session.

### 5.2 Event handlers

1. **`session_start`** — load config, log version, initial state, compute enabled-set duy nhất cho tools/sub-agents/skills, rồi call `pi.setActiveTools` để lọc theo capability graph đã resolve.
2. **`resources_discover`** — return `skillPaths` trỏ tới `skills/` của package, nhưng chỉ expose resources phù hợp với enabled-set hiện hành.
3. **`before_agent_start`** — inject `<available_resources>` + language-matching block vào system prompt; phải detect block đã tồn tại để tránh append lặp qua nhiều turn.
4. **`before_provider_request`** — thêm `x-initiator: agent` nếu provider là Copilot; map reasoning params nếu Pi chưa tự làm.
5. **`model_select`** — cache model family để handler khác dùng.
6. **`tool_call`** (optional) — gate lệnh nguy hiểm (disabled mặc định, opt-in).
7. **`tool_result`** — hashline rewrite cho `read`/`write` khi bật; skip non-text payloads, preserve `isError`, và guard input/payload không đúng format mong đợi.
8. **`session_shutdown`** — flush logger buffer.

### 5.3 Commands

- `/setup-models` — wizard như oc-blackbytes: detect providers, ask defaults, recommend reasoning, ghi settings. Dùng `ctx.ui.select/input/confirm`, write với `JSON.stringify` + `fs.writeFile` (KHÔNG dùng JSONC). Phải preserve mọi keys không liên quan, de-duplicate `packages`, validate JSON trước khi ghi, không log secret values, và yêu cầu confirm trước khi overwrite giá trị `blackbytes` đã tồn tại.
- `/blackbytes-status` (optional, nice-to-have) — hiện enabled tools/sub-agents/config.

### 5.4 Skills bundled

| Skill | Mục đích |
|---|---|
| `blackbytes-overview` | Giới thiệu extension, list tools, khi nào dùng |
| `hashline-workflow` | Giải thích LINE#ID format + batching rules (port từ prompt hiện tại) |
| `delegation` | Khi nào gọi `delegate_oracle` / `delegate_explore` thay vì tự làm |

---

## 6. Non-Functional Requirements

- **Performance:** overhead của extension < 50ms cho mỗi `tool_result` trung bình; hashline rewrite O(n) theo số dòng file.
- **Startup:** `session_start` hoàn tất < 200ms.
- **Size:** package compiled < 500KB gzipped.
- **Node runtime:** Node ≥ 20.
- **Logging:** file log rotate theo ngày, max 10MB.
- **Error handling:** handler failure KHÔNG crash Pi — bắt toàn bộ, log, `ctx.ui.notify("error", ...)`.
- **Config safety:** `/setup-models` không được làm mất settings hiện có, không được ghi JSON invalid, và phải xử lý rõ các case file thiếu / malformed / concurrent update.
- **Security:** không thực thi lệnh hệ thống ngoài các tool bundled; API keys đọc từ settings không log.
- **Validation:** có integration tests cho `before_agent_start`, `before_provider_request`, `tool_result`, nested sub-agent runner, và config loading; mỗi test phải cover cả success path lẫn error path.
- **Output safety:** hashline rewrite phải skip non-text payloads, preserve `isError` responses, và không duplicate prompt/resource blocks qua nhiều turn.
- **HTTP resilience:** mọi HTTP-backed tool phải có timeout mặc định, error normalization nhất quán, redaction của secrets/headers, và retry policy rõ ràng hoặc explicit no-retry policy theo provider.
- **Prompt/idempotency safety:** `<available_resources>` injection phải detect block đã tồn tại để không append lặp; hashline rewrite phải có guard cho large payloads, binary/non-text responses, và input không đúng format mong đợi.
- **Observability:** logs phải đủ để debug provider/tool failure nhưng không dump full third-party payload hoặc secret-bearing headers/query params.

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Pi thay đổi event signature | High | Pin `@mariozechner/pi-coding-agent` peer range hẹp; CI matrix test với latest |
| `tool_result` rewrite conflict với Pi internals | Medium | Chỉ rewrite text blocks, detect isError, preserve details |
| Sub-agent spawn tốn token/resource | Medium | Cache provider client, reuse process pool, expose flag disable |
| Pi sau này add MCP support | Low | MVP vẫn dùng custom tools; v2 có thể migrate |
| Hashline edit conflict với Pi's edit tool | Medium | Không touch Pi's `edit`, chỉ thêm `hashline_edit` song song; document rõ |
| Settings không hỗ trợ JSONC | Low | Docs nói rõ; setup wizard ghi JSON chuẩn |

---

## 8. Milestones

| M | Scope | Duration |
|---|---|---|
| **M0 — Feasibility spike** | Verify nested Pi session strategy (`AgentSession` vs subprocess), `before_provider_request` header mutation cho Copilot, dynamic tool activation semantics, prompt mutation hooks, và nested-session tool restriction path. M0 phải xuất ra decision record chốt: execution path mặc định, fallback path, tool-allowlist enforcement, timeout/cancellation semantics, result transport contract, và recursion guard cho nested sessions. M1/M4 không bắt đầu nếu các quyết định này chưa được ghi lại. | 0.5 tuần |
| **M1 — Skeleton** | Package layout, entry point, config loader, `session_start` handler, logger, và integration path đã được chốt từ M0 | 1 tuần |
| **M2 — Tools parity** | Port 5 bundled tools + 5 MCP-replacement tools + unit tests | 1.5 tuần |
| **M3 — Post-processing & injection** | Hashline `tool_result`, `<available_resources>`, Copilot header | 1 tuần |
| **M4 — Sub-agents** | Delegate_* tools + nested Pi runner + prompts bundled + allowlist enforcement theo persona | 1.5 tuần |
| **M5 — UX** | `/setup-models` wizard, skills, README, examples | 1 tuần |
| **M6 — QA & release** | E2E tests, docs site, npm publish v0.1.0 | 1 tuần |

**Total estimate:** ~7.5 tuần cho MVP.

---

## 9. Open Questions

1. Pi có export `AgentSession` programmatic API để spawn sub-agent không, hay phải dùng subprocess? — **M0 phải chốt trước khi vào M4**.
2. `before_provider_request` có cho phép thêm custom HTTP headers vào payload hay chỉ body? — **M0 phải chốt trước khi triển khai G5**.
3. `pi.setActiveTools` có dynamic được sau `session_start` không? — **M0 phải chốt trước khi triển khai filtering tool/sub-agent**.
4. Model fallback chain có nên port ở MVP không hay để v2?
5. Có nên bundle thêm agent `bytes` dưới dạng skill-first thay vì inject system prompt toàn cục? (tác động lớn tới UX).

---

## 10. Appendix — Mapping Matrix

| oc-blackbytes concept | pi-blackbytes equivalent |
|---|---|
| `src/index.ts` Plugin entry | `src/index.ts` Extension default export |
| `src/bootstrap.ts` Hook assembly | `src/bootstrap.ts` Event subscription |
| `config` hook | `session_start` + `resources_discover` |
| `chat.headers` hook | `before_provider_request` (header injection) |
| `chat.params` hook | `model_select` + `before_provider_request` (param rewrite) |
| `tool` hook | `pi.registerTool()` calls |
| `tool.execute.after` hook | `tool_result` event |
| `extensions/agents/*` | `src/sub-agents/*` tools + `src/prompts/*` markdown |
| `extensions/tools/*` | `src/tools/*` + `pi.registerTool` |
| `extensions/mcp/*` | `src/tools/{websearch,context7,grep-app}/*` custom tools |
| `extensions/commands/setup-models` | `pi.registerCommand("setup-models", ...)` |
| `config/loader.ts` JSONC | Đọc `settings.json.blackbytes` (JSON only) |
| `<available_resources>` injection | `before_agent_start` returning `systemPrompt` |
| Permission map | **dropped** — Pi không có permission system |
| Buffered logger | Port 1:1 |
| OpenCode config dir resolution | Use `~/.pi/agent/` hoặc `process.env.PI_AGENT_DIR` |
