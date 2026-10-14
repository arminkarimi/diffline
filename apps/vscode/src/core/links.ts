// Links that open a review in Diffline, and pull request links on the clipboard. No VS Code here, so it's testable.
//   <scheme>://arminkarimi.diffline/open?pr=owner/name%23123
//   <scheme>://arminkarimi.diffline/open?url=https://github.com/owner/name/pull/123
// <scheme> is the editor's own (vscode.env.uriScheme): vscode, vscode-insiders, cursor and so on.

import { parseKey } from "./service.ts";
import type { PrKey } from "./types.ts";

export const EXTENSION_ID = "arminkarimi.diffline";

/** The link that opens a pull request's review, for the editor whose URI scheme is `scheme`. */
export function reviewLink(scheme: string, key: PrKey): string {
  return `${scheme}://${EXTENSION_ID}/open?pr=${key.owner}/${key.name}%23${key.number}`;
}

/** A GitHub pull request page (https://github.com/owner/name/pull/123, and its tabs) as a key; nothing else. */
function githubPullRequest(text: string): PrKey | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !/^(www\.)?github\.com$/i.test(url.hostname) || url.username || url.password || url.port) return null;
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/[^]*)?$/.exec(url.pathname);
  return m ? keyIn(`${m[1]}/${m[2]}#${m[3]}`) : null;
}

/** owner/name#123 with names GitHub allows and a pull request number GitHub could have given. */
function keyIn(text: string): PrKey | null {
  if (!/^[^/\s]+\/[^#\s]+#\d{1,9}$/.test(text.trim())) return null;
  const key = parseKey(text);
  return key && key.number >= 1 ? key : null;
}

const USAGE = `Use ${EXTENSION_ID}/open?pr=owner/name%23123 or ?url= with a GitHub pull request link.`;

/**
 * The pull request a Diffline link names, or why it doesn't name one. Takes the parts of the URI as VS Code hands them
 * to the extension's URI handler (decoded). The path is /open; the query has `pr` (owner/name#123) or `url` (a GitHub
 * pull request link). An unescaped "#" in ?pr=owner/name#123 starts the URI's fragment, so a number there completes it.
 * Anything else is refused: the link may come from anywhere, and it only ever opens a review.
 */
export function parseOpenLink(uri: { path: string; query: string; fragment: string }): { key: PrKey } | { error: string } {
  if (!/^\/open\/?$/i.test(uri.path)) return { error: `That link isn't one Diffline knows. ${USAGE}` };
  if (uri.query.length > 2000) return { error: `That link is too long. ${USAGE}` };
  const params = new URLSearchParams(uri.query);
  const url = params.get("url");
  const pr = params.get("pr");
  if (url !== null && pr === null) {
    const key = githubPullRequest(url);
    return key ? { key } : { error: `That link doesn't name a GitHub pull request. ${USAGE}` };
  }
  if (pr !== null && url === null) {
    const fragment = /^\d{1,9}$/.test(uri.fragment) ? uri.fragment : "";
    const key = keyIn(!pr.includes("#") && fragment ? `${pr}#${fragment}` : pr);
    return key ? { key } : { error: `That link doesn't name a pull request as owner/name#number. ${USAGE}` };
  }
  return { error: `That link doesn't say which pull request to open. ${USAGE}` };
}

/**
 * A pull request on the clipboard, for Open a Pull Request… to start with: a GitHub pull request link, owner/name#123, or
 * a Diffline link, alone (not inside other text). Returns the GitHub link, or undefined when there's none.
 */
export function clipboardPullRequest(text: string, scheme = "vscode"): string | undefined {
  const t = (text || "").trim();
  if (!t || t.length > 2000 || /\s/.test(t)) return undefined;
  let key = githubPullRequest(t) || keyIn(t);
  if (!key) {
    try {
      const u = new URL(t);
      if (u.protocol === `${scheme}:` && u.hostname.toLowerCase() === EXTENSION_ID) {
        const parsed = parseOpenLink({ path: decodeURIComponent(u.pathname), query: decodeURIComponent(u.search.slice(1)), fragment: decodeURIComponent(u.hash.slice(1)) });
        if ("key" in parsed) key = parsed.key;
      }
    } catch {
      /* not a link */
    }
  }
  return key ? `https://github.com/${key.owner}/${key.name}/pull/${key.number}` : undefined;
}
