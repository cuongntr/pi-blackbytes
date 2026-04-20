import type { PromptSection, PromptSectionKey, PromptSectionMap } from "./types.js";

const SECTION_ORDER: PromptSectionKey[] = [
  "precedence",
  "session_capabilities",
  "hard_boundaries",
  "work_defaults",
  "conditional_workflows",
  "completion_contract",
];

function orderedSections(sectionMap: PromptSectionMap): PromptSection[] {
  return SECTION_ORDER.map((key) => sectionMap[key]);
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
