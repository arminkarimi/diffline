// Just enough of the vscode module for ReviewPanel, the sidebar tree and the extension's activation, so their tests run
// without VS Code. panel.test.ts, tree.test.ts and extension.test.ts map "vscode" here.

import path from "node:path";

type Listener<T> = (value: T) => void;

export class FakeWebview {
  html = "";
  readonly cspSource = "vscode-resource:";
  readonly posted: any[] = [];
  private listeners: Array<Listener<any>> = [];
  onDidReceiveMessage(fn: Listener<any>) {
    this.listeners.push(fn);
    return { dispose: () => undefined };
  }
  postMessage(m: unknown) {
    this.posted.push(m);
    return Promise.resolve(true);
  }
  asWebviewUri(uri: { fsPath: string }) {
    return { toString: () => `vscode-resource:${uri.fsPath}` };
  }
  /** What the page would send. */
  receive(m: unknown) {
    for (const fn of this.listeners) fn(m);
  }
}

export class FakePanel {
  readonly webview = new FakeWebview();
  title = "";
  iconPath: unknown;
  viewColumn = 1;
  disposed = false;
  private disposeListeners: Array<() => void> = [];
  reveal() {}
  onDidDispose(fn: () => void) {
    this.disposeListeners.push(fn);
  }
  dispose() {
    this.disposed = true;
    for (const fn of this.disposeListeners) fn();
  }
}

export const created: FakePanel[] = [];
export const executed: unknown[][] = [];

export const ViewColumn = { Active: -1 };
export const Uri = {
  file: (fsPath: string) => ({ fsPath }),
  joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }),
  parse: (value: string) => ({ value, toString: () => value }),
};
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const QuickPickItemKind = { Separator: -1, Default: 0 };

/* The extension's activation (extension.test.ts). */

const disposable = () => ({ dispose: () => undefined });
/** Commands the extension registered, by id. */
export const registered = new Map<string, (...args: any[]) => unknown>();
/** URI handlers the extension registered. */
export const uriHandlers: Array<{ handleUri(uri: unknown): unknown }> = [];
/** Messages shown, as [kind, text, the buttons offered]. */
export const shown: Array<[string, string, string[]?]> = [];
/** How the next message whose text matches answers (the button pressed); unmatched messages are dismissed. */
export const answers: Array<{ match: RegExp; answer: string }> = [];
const message = (kind: string) => async (text: string, ...rest: unknown[]) => {
  shown.push([kind, text, rest.filter((r): r is string => typeof r === "string")]);
  const i = answers.findIndex((a) => a.match.test(text));
  return i < 0 ? undefined : answers.splice(i, 1)[0].answer;
};
/** Terminals the extension opened: their options, what was typed and whether Enter was pressed. */
export const terminals: Array<{ options: any; sent: Array<[string, boolean | undefined]>; shown: boolean }> = [];
/** What the next input box answers (undefined: dismissed), and the options each one opened with. */
export const inputBox: { answer: string | undefined; opened: any[] } = { answer: undefined, opened: [] };
/** Settings by section and key ("diffline.watch.teamRequests"); missing ones read as the default the extension passes. */
export const settings = new Map<string, unknown>();
/** What the next save dialog answers (undefined: cancelled), and the options each one was opened with. */
export const saveDialog: { answer: { fsPath: string } | undefined; opened: any[] } = { answer: undefined, opened: [] };
export const window = {
  createOutputChannel: () => ({ info() {}, show() {}, dispose() {} }),
  createTreeView: () => ({ description: "", badge: undefined, dispose() {} }),
  createStatusBarItem: () => ({ text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} }),
  registerUriHandler: (handler: { handleUri(uri: unknown): unknown }) => {
    uriHandlers.push(handler);
    return disposable();
  },
  showInputBox: async (opts: unknown) => {
    inputBox.opened.push(opts);
    return inputBox.answer;
  },
  showInformationMessage: message("info"),
  showWarningMessage: message("warning"),
  showErrorMessage: message("error"),
  createTerminal: (options: unknown) => {
    const t = { options, sent: [] as Array<[string, boolean | undefined]>, shown: false };
    terminals.push(t);
    return { show: () => void (t.shown = true), sendText: (text: string, addNewLine?: boolean) => void t.sent.push([text, addNewLine]), dispose() {} };
  },
  showQuickPick: async () => undefined,
  withProgress: async (_o: unknown, fn: () => Promise<unknown>) => fn(),
  createWebviewPanel: () => {
    const panel = new FakePanel();
    created.push(panel);
    return panel;
  },
  showSaveDialog: async (opts: unknown) => {
    saveDialog.opened.push(opts);
    return saveDialog.answer;
  },
};
/** What the extension last put on the clipboard. */
export const env = {
  uriScheme: "vscode",
  appName: "Visual Studio Code",
  clipboard: {
    text: "",
    async writeText(text: string) {
      env.clipboard.text = text;
    },
    async readText() {
      return env.clipboard.text;
    },
  },
  openExternal: async () => true,
};
/** Installed extensions other than Diffline, by ID. */
export const installed = new Set<string>();
export const extensions = { getExtension: (id: string) => (installed.has(id) ? { id } : undefined) };

export const commands = {
  executeCommand: async (...args: unknown[]) => void executed.push(args),
  registerCommand: (id: string, fn: (...args: any[]) => unknown) => {
    registered.set(id, fn);
    return disposable();
  },
};
export const workspace = {
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  getConfiguration: (section = "") => ({
    get: (key: string, fallback?: unknown) => {
      const id = section ? `${section}.${key}` : key;
      return settings.has(id) ? settings.get(id) : fallback;
    },
    update: async (key: string, value: unknown) => void settings.set(section ? `${section}.${key}` : key, value),
  }),
  onDidChangeConfiguration: () => disposable(),
  onDidChangeWorkspaceFolders: () => disposable(),
};

/* The sidebar tree (tree.test.ts). */

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export class TreeItem {
  description?: string;
  tooltip?: unknown;
  id?: string;
  iconPath?: unknown;
  contextValue?: string;
  command?: unknown;
  label: string;
  collapsibleState: number;
  constructor(label: string, collapsibleState: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
export class ThemeColor {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}
export class ThemeIcon {
  id: string;
  color?: ThemeColor;
  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    this.color = color;
  }
}
/** Markdown as one string; appendText escapes Markdown the way VS Code does (roughly). */
export class MarkdownString {
  value = "";
  appendMarkdown(s: string) {
    this.value += s;
    return this;
  }
  appendText(s: string) {
    this.value += s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
    return this;
  }
}
export class EventEmitter<T> {
  private listeners: Array<Listener<T>> = [];
  readonly event = (fn: Listener<T>) => {
    this.listeners.push(fn);
    return { dispose: () => undefined };
  };
  fire(value: T) {
    for (const fn of this.listeners) fn(value);
  }
  dispose() {
    this.listeners = [];
  }
}
