// CODEOWNERS: who owns which files, so the sidebar can list pull requests that change files you or your teams own.
// Patterns follow GitHub's rules (gitignore style): the last matching line wins, a pattern with a slash at the start
// or in the middle is relative to the repository root, one without matches at any depth, and a directory matches
// everything under it.

export interface OwnerRule {
  pattern: string;
  re: RegExp;
  /** As written, lowercased: "@user", "@org/team" or an email. */
  owners: string[];
}

/** The places GitHub looks for the file, in its order of precedence. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

function patternToRegExp(pattern: string): RegExp {
  let p = pattern;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith("/") || p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      // "**/" matches any number of folders, a trailing "**" everything below.
      if (p[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A match can be the path itself or a folder above it, except that a last part with a wildcard ("docs/*") only
  // matches at that level, as GitHub documents.
  const last = p.slice(p.lastIndexOf("/") + 1);
  const below = dirOnly ? "/.*" : /\*|\?/.test(last) && last !== "**" ? "" : "(?:/.*)?";
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}${below}$`);
}

export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || pattern.startsWith("!")) continue;
    try {
      rules.push({ pattern, re: patternToRegExp(pattern), owners: owners.map((o) => o.toLowerCase()) });
    } catch {
      /* a pattern GitHub would reject too */
    }
  }
  return rules;
}

/** The owners of one file: those on the last line that matches it. */
export function ownersOf(path: string, rules: OwnerRule[]): string[] {
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i].re.test(path)) return rules[i].owners;
  return [];
}

/** Whether you own any of the files, by name ("@login") or through a team ("@org/slug"). */
export function ownsAny(paths: string[], rules: OwnerRule[], me: { login: string; teams: string[] }): boolean {
  if (!rules.length) return false;
  const mine = new Set([`@${me.login.toLowerCase()}`, ...me.teams.map((t) => `@${t.toLowerCase()}`)]);
  return paths.some((p) => ownersOf(p, rules).some((o) => mine.has(o)));
}
