#!/usr/bin/env node
// A stand-in for the Pi coding agent CLI in tests. It records how it was started (arguments, working folder, what
// was in it, environment, stdin) to $PI_FAKE_RECORD, then answers like `pi --mode json`. $PI_FAKE_MODE picks the
// answer; $PI_FAKE_REPLY is the final assistant text.

import { readdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = process.env.PI_FAKE_MODE || "ok";

const record = (stdin) => {
  if (!process.env.PI_FAKE_RECORD) return;
  writeFileSync(process.env.PI_FAKE_RECORD, JSON.stringify({ args, cwd: process.cwd(), entries: readdirSync(process.cwd()), env: process.env, stdin }));
};

if (args.includes("--version")) {
  // Like Pi, version and model list go to stderr when stdin isn't a terminal.
  process.stderr.write(`${process.env.PI_FAKE_VERSION || "1.1.0"}\n`);
  process.exit(0);
}

if (args.includes("--list-models")) {
  record("");
  if (mode === "no-models") {
    process.stdout.write("No models available. Use /login or set an API key environment variable.\n");
  } else {
    process.stderr.write(
      [
        "provider   model                context  max-out  thinking  images",
        "\x1b[0manthropic  claude-opus-4-7      200K     64K      yes       yes",
        "openai     gpt-6.1-sol          400K     128K     yes       yes",
        "groq       llama-4-scout-small  128K     8K       no        no",
        "",
      ].join("\n"),
    );
  }
  process.exit(0);
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  record(stdin);
  const line = (e) => process.stdout.write(JSON.stringify(e) + "\n");
  const assistant = (content, extra) => ({
    role: "assistant",
    content,
    provider: "anthropic",
    model: "claude-opus-4-7",
    usage: { input: 5120, output: 830, cacheRead: 40000, cacheWrite: 0, totalTokens: 45950, cost: { input: 0.02, output: 0.06, cacheRead: 0.02, cacheWrite: 0, total: 0.1 } },
    stopReason: "stop",
    ...extra,
  });
  switch (mode) {
    case "no-key":
      process.stderr.write("Error: No API key found for anthropic.\n");
      process.exit(1);
    case "unknown-model":
      process.stderr.write('Error: Model "nope" not found. Use --list-models to see available models.\n');
      process.exit(1);
    case "crash":
      process.stderr.write("Error: something broke\n");
      process.exit(2);
    case "hang":
      setTimeout(() => undefined, 60_000);
      return;
  }
  line({ type: "session", version: 3, id: "s1", timestamp: "2026-10-11T00:00:00.000Z", cwd: process.cwd() });
  line({ type: "agent_start" });
  line({ type: "turn_start" });
  if (mode === "silent") return;
  line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "…" }] } });
  line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "…" }] } });
  line({ type: "message_end", message: assistant([{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } }], { stopReason: "toolUse", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 300, cost: { total: 0.01 } } }) });
  line({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/x" } });
  line({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: {}, isError: false });
  const text = process.env.PI_FAKE_REPLY || "{}";
  if (mode === "provider-error") line({ type: "message_end", message: assistant([], { stopReason: "error", errorMessage: "429 rate_limit_error: slow down" }) });
  else if (mode === "auth-error") line({ type: "message_end", message: assistant([], { stopReason: "error", errorMessage: "401 authentication_error: invalid x-api-key" }) });
  else if (mode === "length") line({ type: "message_end", message: assistant([{ type: "text", text: text.slice(0, 5) }], { stopReason: "length" }) });
  else line({ type: "message_end", message: assistant([{ type: "thinking", thinking: "Let me answer." }, { type: "text", text }]) });
  line({ type: "turn_end" });
  line({ type: "agent_end", messages: [] });
});
