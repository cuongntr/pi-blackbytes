import { Type } from "typebox";

/** File or directory path parameter */
export const PathParam = Type.String({
  description: "Absolute or relative file/directory path",
});

/** Glob pattern parameter */
export const GlobPatternParam = Type.String({
  description: "Glob pattern (e.g. **/*.ts)",
});

/** File content parameter */
export const ContentParam = Type.String({
  description: "File content to write",
});

/** Search/grep regex pattern parameter */
export const SearchPatternParam = Type.String({
  description: "Regular expression pattern for searching",
});
