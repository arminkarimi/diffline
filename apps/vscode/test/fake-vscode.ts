// Just enough of the vscode module for ReviewPanel, so panel tests run without VS Code. panel.test.ts maps "vscode" here.

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
export const commands = {
  executeCommand: async (...args: unknown[]) => void executed.push(args),
};
