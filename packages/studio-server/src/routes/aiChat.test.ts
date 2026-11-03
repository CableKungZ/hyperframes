import { describe, expect, it } from "vitest";
import { buildPrompt, claudeLineToEvents, parseAiChatRequest } from "./aiChat.js";

describe("claudeLineToEvents", () => {
  it("reads the session id from the init line", () => {
    expect(
      claudeLineToEvents(JSON.stringify({ type: "system", subtype: "init", session_id: "abc-1" })),
    ).toEqual([{ type: "session", sessionId: "abc-1" }]);
  });

  it("turns assistant text and tool use into events", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Editing the title" },
          { type: "tool_use", name: "Edit", input: { file_path: "index.html" } },
        ],
      },
    });
    expect(claudeLineToEvents(line)).toEqual([
      { type: "text", text: "Editing the title" },
      { type: "tool", name: "Edit", detail: "index.html" },
    ]);
  });

  it("reports an error result and finishes", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "Not logged in",
      session_id: "s",
      total_cost_usd: 0,
    });
    expect(claudeLineToEvents(line)).toEqual([
      { type: "error", message: "Not logged in" },
      { type: "done", sessionId: "s", costUsd: 0 },
    ]);
  });

  it("ignores lines that are not JSON", () => {
    expect(claudeLineToEvents("warning: something")).toEqual([]);
  });
});

describe("parseAiChatRequest", () => {
  it("refuses a session id a shell could read", () => {
    expect(
      parseAiChatRequest({
        projectId: "p",
        provider: "claude",
        message: "hi",
        sessionId: "x & del",
      }),
    ).toBe("invalid sessionId");
  });

  it("keeps the transcript only for providers without sessions", () => {
    const request = parseAiChatRequest({
      projectId: "p",
      provider: "codex",
      message: "make it red",
      history: [{ role: "user", text: "hello" }],
      context: { activeComposition: "index.html", attachments: ["assets/a.mp4"] },
    });
    if (typeof request === "string") throw new Error(request);
    const prompt = buildPrompt(request, "/proj", true);
    expect(prompt).toContain("user: hello");
    expect(prompt).toContain("assets/a.mp4");
    expect(prompt.endsWith("make it red")).toBe(true);
  });
});
