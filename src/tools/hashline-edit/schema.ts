import { type Static, Type } from "typebox";

export const EditSchema = Type.Object({
  op: Type.Union([
    Type.Literal("replace"),
    Type.Literal("append"),
    Type.Literal("prepend"),
    Type.Literal("replace_text"),
    Type.Literal("insert_after"),
    Type.Literal("insert_before"),
    Type.Literal("replace_range"),
  ]),
  pos: Type.Optional(Type.String({ description: "LINE#ID anchor e.g. '10#VK'" })),
  end: Type.Optional(Type.String({ description: "End LINE#ID anchor for range ops" })),
  lines: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()])),
  oldText: Type.Optional(
    Type.String({
      description:
        "replace_text only: exact substring to replace. Must occur EXACTLY ONCE in the file. Multi-line allowed (use LF, not CRLF).",
    }),
  ),
  newText: Type.Optional(
    Type.String({
      description: "replace_text only: replacement substring. Empty string deletes the match.",
    }),
  ),
});

export type Edit = Static<typeof EditSchema>;

export const HashlineEditSchema = Type.Object({
  filePath: Type.String({ description: "Absolute path to file" }),
  edits: Type.Array(EditSchema, { description: "Operations to apply" }),
  delete: Type.Optional(Type.Boolean({ description: "Delete the file" })),
  rename: Type.Optional(Type.String({ description: "Rename/move to new path" })),
  postEditVerify: Type.Optional(
    Type.Boolean({
      description:
        "When true, re-read the file after write and compare byte-for-byte against the intended content. On mismatch, rollback and return [E_VERIFY_FAILED]. Default false; opt-in per call (extra read syscall cost).",
    }),
  ),
});

export type HashlineEditInput = Static<typeof HashlineEditSchema>;
