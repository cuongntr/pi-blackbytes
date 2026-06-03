import type { Theme } from "@earendil-works/pi-coding-agent";

const SHELL_VAR_RE = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;
const SHELL_OP_RE = /^(?:&&|\|\||>>|>&|\|&|[|&;()<>])$/;

function normalizeWord(word: string): string {
  return word.replace(/^(['"])(.*)\1$/, "$2");
}

function colorWord(theme: Theme, word: string, commandExpected: boolean): string {
  const normalized = normalizeWord(word);
  if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(normalized)) return theme.fg("syntaxVariable", word);
  if (normalized.startsWith("-")) return theme.fg("syntaxKeyword", word);
  if (normalized.includes("/") || /^\.{1,2}(?:\/|$)/.test(normalized)) {
    return theme.fg("syntaxVariable", word);
  }
  if (SHELL_VAR_RE.test(normalized)) return theme.fg("syntaxVariable", word);
  return commandExpected ? theme.fg("syntaxFunction", word) : theme.fg("syntaxString", word);
}

export function tokenizeShellLine(line: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < line.length; i++) {
    const char = line[i] ?? "";
    const next = line[i + 1] ?? "";

    if (quote) {
      current += char;
      if (char === "\\" && next) current += line[++i] ?? "";
      else if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      tokens.push(char);
      continue;
    }

    if (char === "#" && !current) {
      tokens.push(line.slice(i));
      return tokens;
    }

    const two = `${char}${next}`;
    if (SHELL_OP_RE.test(two) || SHELL_OP_RE.test(char)) {
      if (current) tokens.push(current);
      current = "";
      if (SHELL_OP_RE.test(two)) {
        tokens.push(two);
        i++;
      } else {
        tokens.push(char);
      }
      continue;
    }

    current += char;
  }

  if (quote) return undefined;
  if (current) tokens.push(current);
  return tokens;
}

export function highlightShellLine(line: string, theme: Theme): string {
  const tokens = tokenizeShellLine(line);
  if (!tokens) return line;
  let commandExpected = true;
  return tokens
    .map((token) => {
      if (/^\s+$/.test(token)) return token;
      if (token.startsWith("#")) return theme.fg("syntaxComment", token);
      if (SHELL_OP_RE.test(token)) {
        commandExpected =
          token === "|" || token === "||" || token === "&&" || token === ";" || token === "&";
        return theme.fg("syntaxOperator", token);
      }
      const styled = colorWord(theme, token, commandExpected);
      if (!/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(normalizeWord(token))) commandExpected = false;
      return styled;
    })
    .join("");
}
