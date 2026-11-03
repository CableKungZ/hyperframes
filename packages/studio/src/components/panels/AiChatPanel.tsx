import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowClockwise,
  Paperclip,
  PaperPlaneRight,
  Plus,
  Sparkle,
  Stop,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { useStudioShellContext } from "../../contexts/StudioContext";
import { useFileManagerContext } from "../../contexts/FileManagerContext";
import { useDomEditContext } from "../../contexts/DomEditContext";
import { studioApiFetch } from "../../utils/studioApiFetch";
import { AiMarkdown } from "./AiMarkdown";
import {
  historyForRequest,
  readAiEventStream,
  useAiChatStore,
  type AiChatMessage,
  type AiProviderId,
  type AiProviderInfo,
} from "./aiChatStore";

const SUGGESTIONS = [
  "ทำ intro 5 วินาที ชื่อช่องเด้งขึ้นมาตรงกลาง",
  "ใส่ซับไตเติลให้คลิปวิดีโอใน assets",
  "เปลี่ยนโทนสีทั้งวิดีโอให้ดูอบอุ่นขึ้น",
];

const FALLBACK_PROVIDERS: AiProviderInfo[] = [
  {
    id: "claude",
    label: "Claude (Claude Code)",
    available: true,
    version: null,
    resumable: true,
    installHint: "",
  },
];

function isProviderList(value: unknown): value is { providers: AiProviderInfo[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "providers" in value &&
    Array.isArray(value.providers)
  );
}

function useProviders() {
  const providers = useAiChatStore((s) => s.providers);
  const setProviders = useAiChatStore((s) => s.setProviders);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(
    async (force: boolean) => {
      setChecking(true);
      try {
        const res = await studioApiFetch(`/api/ai/providers${force ? "?refresh=1" : ""}`);
        const data: unknown = await res.json();
        if (isProviderList(data)) setProviders(data.providers);
      } catch {
        setProviders([]);
      } finally {
        setChecking(false);
      }
    },
    [setProviders],
  );

  useEffect(() => {
    if (providers === null) void refresh(false);
  }, [providers, refresh]);

  return { providers, checking, refresh };
}

function MessageView({ message }: { message: AiChatMessage }) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
    return (
      <div className="flex flex-col items-end gap-1">
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1">
            {message.attachments.map((path) => (
              <span
                key={path}
                className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
              >
                {path}
              </span>
            ))}
          </div>
        )}
        <div className="max-w-[90%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-neutral-700/70 px-3 py-2 text-[12px] leading-relaxed text-neutral-100">
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {message.parts.map((part, index) => {
        if (part.kind === "tool") {
          return (
            <div
              key={index}
              className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-neutral-500"
            >
              <Wrench size={11} className="shrink-0" />
              <span className="shrink-0 font-medium text-neutral-400">{part.name}</span>
              <span className="truncate font-mono">{part.detail}</span>
            </div>
          );
        }
        if (part.kind === "error") {
          return (
            <div
              key={index}
              className="whitespace-pre-wrap break-words rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-1.5 text-[11px] text-red-300"
            >
              {part.text}
            </div>
          );
        }
        return <AiMarkdown key={index} text={part.text} />;
      })}
    </div>
  );
}

function describeSelection(
  selection: {
    label: string;
    tagName: string;
    id?: string | null;
    sourceFile: string;
  } | null,
): string | null {
  if (!selection) return null;
  const id = selection.id ? ` #${selection.id}` : "";
  return `${selection.label} <${selection.tagName.toLowerCase()}${id}> in ${selection.sourceFile}`;
}

/** Studio's AI sidebar: chats with a signed-in AI CLI that edits the project files. */
export function AiChatPanel() {
  const { projectId, activeCompPath, showToast } = useStudioShellContext();
  const { handleImportFiles, refreshFileTree } = useFileManagerContext();
  const { domEditSelection } = useDomEditContext();
  const { providers, checking, refresh } = useProviders();

  const provider = useAiChatStore((s) => s.provider);
  const setProvider = useAiChatStore((s) => s.setProvider);
  const messages = useAiChatStore((s) => s.messages);
  const running = useAiChatStore((s) => s.running);
  const attachments = useAiChatStore((s) => s.attachments);
  const addAttachments = useAiChatStore((s) => s.addAttachments);
  const removeAttachment = useAiChatStore((s) => s.removeAttachment);
  const newChat = useAiChatStore((s) => s.newChat);
  const fullAccess = useAiChatStore((s) => s.fullAccess);
  const setFullAccess = useAiChatStore((s) => s.setFullAccess);

  const [draft, setDraft] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const current = providers?.find((p) => p.id === provider) ?? null;
  const selectionText = describeSelection(domEditSelection);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const uploadAndAttach = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      const uploaded = await handleImportFiles(list, "assets");
      if (Array.isArray(uploaded) && uploaded.length > 0) {
        addAttachments(uploaded);
        showToast(`อัปโหลดแล้ว ${uploaded.length} ไฟล์`, "info");
      }
    },
    [handleImportFiles, addAttachments, showToast],
  );

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      const state = useAiChatStore.getState();
      if (!message || state.running) return;
      const sentAttachments = state.attachments;
      const history = historyForRequest(state.messages);
      state.startTurn(message, sentAttachments);
      setDraft("");

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await studioApiFetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            projectId,
            provider: state.provider,
            message,
            sessionId: state.sessionId,
            fullAccess: state.fullAccess,
            history,
            context: {
              activeComposition: activeCompPath,
              selection: selectionText,
              attachments: sentAttachments,
            },
          }),
        });
        if (!res.ok || !res.body) {
          const data: unknown = await res.json().catch(() => null);
          const error =
            typeof data === "object" && data !== null && "error" in data
              ? String(data.error)
              : `HTTP ${res.status}`;
          state.applyEvent({ type: "error", message: error });
          return;
        }
        await readAiEventStream(res.body, (event) => useAiChatStore.getState().applyEvent(event));
      } catch (error) {
        if (!controller.signal.aborted) {
          useAiChatStore.getState().applyEvent({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        abortRef.current = null;
        useAiChatStore.getState().finishTurn();
        // The AI may have added or removed files; Studio's own watcher reloads the preview.
        refreshFileTree();
      }
    },
    [projectId, activeCompPath, selectionText, refreshFileTree],
  );

  const stop = useCallback(() => {
    void studioApiFetch("/api/ai/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    }).catch(() => undefined);
    abortRef.current?.abort();
  }, [projectId]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(draft);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files.length > 0) {
      void uploadAndAttach(event.dataTransfer.files);
      return;
    }
    // An asset dragged from the Assets panel carries its project path as text.
    const path = event.dataTransfer.getData("text/plain").trim();
    if (path && !path.includes("\n")) addAttachments([path]);
  };

  const unavailable = providers !== null && current !== null && !current.available;

  return (
    <div
      className={`relative flex h-full min-h-0 flex-col ${dragOver ? "bg-neutral-800/40" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-neutral-800 px-2 py-1.5">
        <Sparkle size={14} weight="fill" className="shrink-0 text-amber-300" />
        <select
          aria-label="AI provider"
          className="min-w-0 flex-1 truncate rounded-md border border-neutral-800 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 outline-hidden"
          value={provider}
          disabled={running}
          onChange={(e) => {
            const value = e.target.value;
            if (value === "claude" || value === "codex" || value === "gemini") {
              setProvider(value satisfies AiProviderId);
            }
          }}
        >
          {(providers ?? FALLBACK_PROVIDERS).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.available ? "" : " (ยังไม่ได้ติดตั้ง)"}
            </option>
          ))}
        </select>
        <button
          type="button"
          title="ตรวจหา AI ที่ติดตั้งใหม่"
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          onClick={() => void refresh(true)}
        >
          <ArrowClockwise size={13} className={checking ? "animate-spin" : ""} />
        </button>
        <button
          type="button"
          title="แชทใหม่"
          disabled={running}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
          onClick={newChat}
        >
          <Plus size={13} />
        </button>
      </div>

      <label
        className={`flex shrink-0 cursor-pointer items-center gap-2 border-b border-neutral-800 px-3 py-1.5 text-[11px] ${
          fullAccess ? "bg-red-950/30 text-red-200" : "text-neutral-400"
        }`}
        title="ปิดอยู่: AI แก้ไฟล์และรันคำสั่ง hyperframes ได้เท่านั้น. เปิด: AI รันคำสั่งอะไรก็ได้ในเครื่องโดยไม่ถาม"
      >
        <input
          type="checkbox"
          className="accent-red-500"
          checked={fullAccess}
          disabled={running}
          onChange={(e) => setFullAccess(e.target.checked)}
        />
        อนุญาตทุกคำสั่ง
        <span className="text-neutral-600">
          {fullAccess ? "(AI รันคำสั่งใดก็ได้โดยไม่ถาม)" : "(ตอนนี้: แก้ไฟล์ + คำสั่ง hyperframes)"}
        </span>
      </label>

      {unavailable && current && (
        <div className="shrink-0 border-b border-neutral-800 bg-amber-950/30 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
          ยังไม่พบ {current.label} ในเครื่องนี้. ติดตั้งด้วย: {current.installHint}
        </div>
      )}

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col justify-center gap-2 text-[11.5px] text-neutral-500">
            <p className="text-neutral-400">สั่งงาน AI ให้แก้วิดีโอได้เลย ลากไฟล์หรือ Asset มาวางที่นี่เพื่อแนบ</p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="rounded-lg border border-neutral-800 px-2.5 py-1.5 text-left text-neutral-300 hover:bg-neutral-800/60"
                onClick={() => setDraft(s)}
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          messages.map((m) => <MessageView key={m.id} message={m} />)
        )}
        {running && (
          <div className="flex items-center gap-1.5 text-[11px] text-neutral-500">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
            AI กำลังทำงาน...
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-neutral-800 p-2">
        {(attachments.length > 0 || selectionText || activeCompPath) && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {activeCompPath && (
              <span className="rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
                {activeCompPath}
              </span>
            )}
            {selectionText && (
              <span
                title={selectionText}
                className="max-w-full truncate rounded bg-sky-950/60 px-1.5 py-0.5 text-[10px] text-sky-300"
              >
                เลือก: {domEditSelection?.label}
              </span>
            )}
            {attachments.map((path) => (
              <span
                key={path}
                className="flex items-center gap-1 rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300"
              >
                {path}
                <button
                  type="button"
                  aria-label={`เอา ${path} ออก`}
                  className="text-neutral-500 hover:text-neutral-200"
                  onClick={() => removeAttachment(path)}
                >
                  <X size={9} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900 p-1.5 focus-within:border-neutral-600">
          <button
            type="button"
            title="อัปโหลดไฟล์เข้า assets/ แล้วแนบ"
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void uploadAndAttach(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            value={draft}
            rows={2}
            placeholder="พิมพ์คำสั่ง... (Enter ส่ง, Shift+Enter ขึ้นบรรทัด)"
            className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent text-[12px] text-neutral-100 outline-hidden placeholder:text-neutral-600"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {running ? (
            <button
              type="button"
              title="หยุด"
              className="rounded-md bg-red-900/70 p-1.5 text-red-100 hover:bg-red-800"
              onClick={stop}
            >
              <Stop size={13} weight="fill" />
            </button>
          ) : (
            <button
              type="button"
              title="ส่ง"
              disabled={!draft.trim() || unavailable}
              className="rounded-md bg-neutral-100 p-1.5 text-neutral-900 hover:bg-white disabled:opacity-30"
              onClick={() => void send(draft)}
            >
              <PaperPlaneRight size={13} weight="fill" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
