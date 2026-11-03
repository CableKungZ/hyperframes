import { create } from "zustand";

export type AiProviderId = "claude" | "codex" | "gemini";

export interface AiProviderInfo {
  id: AiProviderId;
  label: string;
  available: boolean;
  version: string | null;
  resumable: boolean;
  installHint: string;
}

export type AiChatPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "error"; text: string };

export interface AiChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: AiChatPart[];
  attachments?: string[];
}

/** Events the studio-server AI bridge streams (see studio-server routes/aiChat.ts). */
export type AiChatEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string | null; costUsd: number | null };

const PROVIDER_KEY = "hf-ai-provider";
const FULL_ACCESS_KEY = "hf-ai-full-access";

function readStoredFullAccess(): boolean {
  try {
    return localStorage.getItem(FULL_ACCESS_KEY) === "1";
  } catch {
    return false;
  }
}

function readStoredProvider(): AiProviderId {
  try {
    const value = localStorage.getItem(PROVIDER_KEY);
    if (value === "claude" || value === "codex" || value === "gemini") return value;
  } catch {
    /* storage unavailable */
  }
  return "claude";
}

interface AiChatState {
  provider: AiProviderId;
  providers: AiProviderInfo[] | null;
  /** The AI may run any command without asking. Off by default. */
  fullAccess: boolean;
  setFullAccess: (on: boolean) => void;
  messages: AiChatMessage[];
  sessionId: string | null;
  running: boolean;
  attachments: string[];
  setProvider: (provider: AiProviderId) => void;
  setProviders: (providers: AiProviderInfo[]) => void;
  addAttachments: (paths: string[]) => void;
  removeAttachment: (path: string) => void;
  clearAttachments: () => void;
  startTurn: (text: string, attachments: string[]) => void;
  applyEvent: (event: AiChatEvent) => void;
  finishTurn: () => void;
  newChat: () => void;
}

let nextId = 0;
const makeId = () => `m${Date.now().toString(36)}${(nextId++).toString(36)}`;

function appendToAssistant(messages: AiChatMessage[], part: AiChatPart): AiChatMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") {
    return [...messages, { id: makeId(), role: "assistant", parts: [part] }];
  }
  const parts = [...last.parts];
  const tail = parts[parts.length - 1];
  if (part.kind === "text" && tail?.kind === "text") {
    // Claude sends whole blocks; separate them. Line-streamed CLIs already end in \n.
    const joiner = tail.text.endsWith("\n") ? "" : "\n\n";
    parts[parts.length - 1] = { kind: "text", text: tail.text + joiner + part.text };
  } else {
    parts.push(part);
  }
  return [...messages.slice(0, -1), { ...last, parts }];
}

export const useAiChatStore = create<AiChatState>((set) => ({
  provider: readStoredProvider(),
  providers: null,
  fullAccess: readStoredFullAccess(),
  setFullAccess: (on) => {
    try {
      localStorage.setItem(FULL_ACCESS_KEY, on ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
    set({ fullAccess: on });
  },
  messages: [],
  sessionId: null,
  running: false,
  attachments: [],
  setProvider: (provider) => {
    try {
      localStorage.setItem(PROVIDER_KEY, provider);
    } catch {
      /* storage unavailable */
    }
    // Sessions belong to one CLI; switching starts a fresh conversation for the new one.
    set({ provider, sessionId: null });
  },
  setProviders: (providers) => set({ providers }),
  addAttachments: (paths) =>
    set((state) => ({
      attachments: [...state.attachments, ...paths.filter((p) => !state.attachments.includes(p))],
    })),
  removeAttachment: (path) =>
    set((state) => ({ attachments: state.attachments.filter((p) => p !== path) })),
  clearAttachments: () => set({ attachments: [] }),
  startTurn: (text, attachments) =>
    set((state) => ({
      running: true,
      attachments: [],
      messages: [
        ...state.messages,
        { id: makeId(), role: "user", parts: [{ kind: "text", text }], attachments },
      ],
    })),
  applyEvent: (event) =>
    set((state) => {
      switch (event.type) {
        case "session":
          return { sessionId: event.sessionId };
        case "text":
          return {
            messages: appendToAssistant(state.messages, { kind: "text", text: event.text }),
          };
        case "tool":
          return {
            messages: appendToAssistant(state.messages, {
              kind: "tool",
              name: event.name,
              detail: event.detail,
            }),
          };
        case "error":
          return {
            messages: appendToAssistant(state.messages, { kind: "error", text: event.message }),
          };
        case "done":
          return event.sessionId ? { sessionId: event.sessionId } : {};
      }
    }),
  finishTurn: () => set({ running: false }),
  newChat: () => set({ messages: [], sessionId: null, attachments: [] }),
}));

/** The transcript as plain text, for CLIs that do not keep their own session. */
export function historyForRequest(
  messages: AiChatMessage[],
): { role: "user" | "assistant"; text: string }[] {
  return messages
    .map((message) => ({
      role: message.role,
      text: message.parts
        .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
        .map((part) => part.text)
        .join("\n")
        .trim(),
    }))
    .filter((turn) => turn.text);
}

const EVENT_TYPES = new Set(["session", "text", "tool", "error", "done"]);

function isAiChatEvent(value: unknown): value is AiChatEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    EVENT_TYPES.has(value.type)
  );
}

/** Splits an SSE byte stream into parsed `data:` events. */
export async function readAiEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AiChatEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          /* ignore a malformed event */
        }
        if (isAiChatEvent(parsed)) onEvent(parsed);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
