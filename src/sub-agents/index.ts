// Barrel export for the sub-agent declaration system.
export { type SubAgentDeclaration, defineSubAgent } from "./declaration.js";
export { registerSubAgent } from "./register.js";
export { resolveToolStrategy } from "./delegable-tools.js";
export { assertUniqueNames } from "./validate-unique.js";
export type { SpawnFn } from "./runner.js";
