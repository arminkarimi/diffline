// Just enough of the vscode module for ReviewPanel and the sidebar tree, so their tests run without VS Code. panel.test.ts
// and tree.test.ts map "vscode" here.

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
};
/** What the next save dialog answers (undefined: cancelled), and the options each one was opened with. */
export const saveDialog: { answer: { fsPath: string } | undefined; opened: any[] } = { answer: undefined, opened: [] };
export const window = {
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
  clipboard: {
    text: "",
    async writeText(text: string) {
      env.clipboard.text = text;
    },
  },
};
export const commands = {
  executeCommand: async (...args: unknown[]) => void executed.push(args),
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
