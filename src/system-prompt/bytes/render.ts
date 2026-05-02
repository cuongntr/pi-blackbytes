import type { PromptSection, PromptSectionKey, PromptSectionMap } from "./types.js";

const SECTION_ORDER: PromptSectionKey[] = [
  "identity",
  "precedence",
  "autonomy_and_persistence",
  "investigate_before_acting",
  "session_capabilities",
  "hard_boundaries",
  "work_defaults",
  "tool_use_protocol",
  "verification_contract",
  "executing_actions_with_care",
  "conditional_workflows",
  "handoff_protocol",
  "markdown_format",
  "file_references",
  "final_status_spec",
  "completion_contract",
];

function orderedSections(sectionMap: PromptSectionMap): PromptSection[] {
  return SECTION_ORDER.map((key) => sectionMap[key]).filter(
    (section): section is PromptSection => section !== undefined,
  );
}

export function renderXmlPrompt(
  sectionMap: PromptSectionMap,
  tags: Record<PromptSectionKey, string>,
): string {
  return orderedSections(sectionMap)
    .map((section) =>
      [
        `<${tags[section.key]}>`,
        `## ${section.title}`,
        "",
        section.body,
        `</${tags[section.key]}>`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function renderMarkdownPrompt(
  sectionMap: PromptSectionMap,
  options: {
    heading: (index: number, title: string) => string;
    afterFirstSection?: string;
  },
): string {
  return orderedSections(sectionMap)
    .map((section, index) => {
      const lines = [options.heading(index + 1, section.title), "", section.body];

      if (index === 0 && options.afterFirstSection) {
        lines.push("", options.afterFirstSection);
      }

      return lines.join("\n");
    })
    .join("\n\n");
}
