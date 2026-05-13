import type { ModelFamily } from "../../shared/model-capability.js";

export type PromptSectionKey =
  | "identity"
  | "precedence"
  | "autonomy_and_persistence"
  | "investigate_before_acting"
  | "session_capabilities"
  | "hard_boundaries"
  | "work_defaults"
  | "tool_use_protocol"
  | "verification_contract"
  | "executing_actions_with_care"
  | "conditional_workflows"
  | "markdown_format"
  | "file_references"
  | "completion_contract";

export interface PromptFeatureFlags {
  readonly hashlineEdit: boolean;
  readonly subagentDelegation: boolean;
  readonly documentationLookup: boolean;
  readonly githubCodeSearch: boolean;
  readonly webSearch: boolean;
}

export interface PromptSection {
  readonly key: PromptSectionKey;
  readonly title: string;
  readonly body: string;
}

export type PromptSectionMap = Partial<Record<PromptSectionKey, PromptSection>>;

export type PromptRenderer = (sections: PromptSectionMap) => string;

export interface BytesPromptRenderContext {
  readonly modelFamily: ModelFamily;
  readonly enabledTools: ReadonlySet<string>;
  readonly enabledSubAgents: ReadonlySet<string>;
  readonly features: PromptFeatureFlags;
}

export interface PromptVariantRenderContext {
  readonly modelFamily: ModelFamily;
  readonly hashlineEditEnabled: boolean;
}

export type PromptBuilder = (family?: ModelFamily, hashlineEditEnabled?: boolean) => string;
