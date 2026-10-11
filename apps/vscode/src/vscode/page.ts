// Builds the review page's HTML from the UI's index.html, with the review data inlined. No VS Code here, so it's testable.

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** JSON that's safe inside a <script>: no "</script>", "<!--" or line separators that end a JavaScript string. */
export const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replaceAll(LS, "\\u2028").replaceAll(PS, "\\u2029");

/**
 * The page's bridge to the extension, which runs before the data. Every message names the pull request the page was
 * built for: while another one loads, this page stays on screen, and a save it sends then (the page saves 350 ms after
 * a change) must still go to its own pull request. Request ids are unique per page, so a late answer meant for the
 * page before can't settle a request of this one.
 */
export function hostShim(key: string): string {
  return `(() => {
  const vscode = acquireVsCodeApi();
  const key = ${scriptJson(key)};
  const page = Math.random().toString(36).slice(2);
  let seq = 0;
  const pending = new Map();
  window.addEventListener("message", (event) => {
    const m = event.data;
    // The extension asks the page to show a view (the sidebar's Home), with a fresh list.
    if (m && (m.type === "host-view" || m.type === "host-list")) { window.dispatchEvent(new CustomEvent("diffline-host", { detail: m })); return; }
    if (!m || m.type !== "api-result") return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.data); else p.reject(new Error(m.error || "The request failed."));
  });
  window.DIFFLINE_HOST = {
    api(method, path, body) {
      const id = page + "-" + ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        vscode.postMessage({ type: "api", key, id, method, path, body });
      });
    },
    reload() { vscode.postMessage({ type: "reload", key }); },
    open(target) { vscode.postMessage({ type: "open", key, target }); },
    runAgents() { vscode.postMessage({ type: "runAgents", key }); },
    // What the reviewer did with agent findings and the reviews they posted, for the local review metrics: { head, run, events }.
    metrics(m) { vscode.postMessage({ type: "metrics", key, head: m && m.head, run: m && m.run, events: m && m.events }); },
  };
})();`;
}

export interface PageParts {
  csp: string;
  nonce: string;
  stylesUrl: string;
  appUrl: string;
  /** Script that runs before the data: the bridge to the extension. */
  shim: string;
  data: unknown;
  live: unknown;
}

export function buildPage(template: string, p: PageParts): string {
  const dataScript = `<script nonce="${p.nonce}">${p.shim}\nwindow.REVIEW_DATA = ${scriptJson(p.data)};\nwindow.DIFFLINE_LIVE = ${scriptJson(p.live)};</script>`;
  // Replacer functions, not strings: in a replacement string, $' $` $& and $$ are patterns, and a diff can hold them
  // (shell scripts do), which would paste parts of the template into the data and break the page.
  return template
    // The page's web font comes from Google; in VS Code it uses the editor's fonts instead (.in-vscode in styles.css).
    .replace(/<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/g, () => "")
    .replace(/<head>/i, () => `<head>\n<meta http-equiv="Content-Security-Policy" content="${p.csp}">`)
    .replace('href="styles.css"', () => `href="${p.stylesUrl}"`)
    .replace('<script src="review-data.js"></script>', () => dataScript)
    .replace('<script src="app.js"></script>', () => `<script nonce="${p.nonce}" src="${p.appUrl}"></script>`);
}
