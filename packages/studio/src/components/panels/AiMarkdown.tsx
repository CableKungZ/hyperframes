import { Fragment, type ReactNode } from "react";

/**
 * A small, safe markdown renderer for AI replies: headings, bullet and numbered
 * lists, fenced code, inline code, bold and italics. Builds React nodes only, so
 * nothing in a reply is ever parsed as HTML.
 */

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((piece, index) => {
    const key = `${keyPrefix}-${index}`;
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
      return (
        <code
          key={key}
          className="rounded bg-neutral-800 px-1 py-px font-mono text-[11px] text-amber-200"
        >
          {piece.slice(1, -1)}
        </code>
      );
    }
    if (
      (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) ||
      (piece.startsWith("__") && piece.endsWith("__") && piece.length > 4)
    ) {
      return (
        <strong key={key} className="font-semibold text-neutral-50">
          {piece.slice(2, -2)}
        </strong>
      );
    }
    if (piece.startsWith("*") && piece.endsWith("*") && piece.length > 2) {
      return <em key={key}>{piece.slice(1, -1)}</em>;
    }
    return <Fragment key={key}>{piece}</Fragment>;
  });
}

type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; text: string };

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        code.push(lines[i] ?? "");
        i++;
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", text: heading[1] ?? "" });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !bullet;
      const item = (bullet ?? numbered)?.[1] ?? "";
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item);
      else blocks.push({ kind: "list", ordered, items: [item] });
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

export function AiMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="flex flex-col gap-1.5 break-words text-[12px] leading-relaxed text-neutral-200">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case "code":
            return (
              <pre
                key={key}
                className="overflow-x-auto rounded-md bg-neutral-900 px-2.5 py-2 font-mono text-[11px] text-neutral-300"
              >
                {block.text}
              </pre>
            );
          case "heading":
            return (
              <div key={key} className="pt-1 font-semibold text-neutral-50">
                {renderInline(block.text, key)}
              </div>
            );
          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag
                key={key}
                className={`flex flex-col gap-0.5 pl-4 ${block.ordered ? "list-decimal" : "list-disc"}`}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ListTag>
            );
          }
          case "paragraph":
            return (
              <p key={key} className="whitespace-pre-wrap">
                {renderInline(block.text, key)}
              </p>
            );
        }
      })}
    </div>
  );
}
