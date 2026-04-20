/**
 * Asserts that sub-agent declaration names are unique across builtin and YAML sources.
 * Duplicate names are a session initialization error — not recoverable.
 */
export function assertUniqueNames(names: readonly string[]): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const name of names) {
    if (seen.has(name)) {
      if (!duplicates.includes(name)) {
        duplicates.push(name);
      }
    } else {
      seen.add(name);
    }
  }

  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate sub-agent names detected: ${duplicates.join(", ")}. Each sub-agent must have a unique name across builtin and YAML declarations.`,
    );
  }
}
