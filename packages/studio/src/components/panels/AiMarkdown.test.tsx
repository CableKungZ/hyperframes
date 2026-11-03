import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiMarkdown } from "./AiMarkdown";

describe("AiMarkdown", () => {
  it("renders lists, bold and code without passing HTML through", () => {
    const html = renderToStaticMarkup(
      <AiMarkdown
        text={"- **0-5s:** title `channelName`\n- <b>raw</b>\n\n```\nnpx hyperframes check\n```"}
      />,
    );
    expect(html).toContain("<ul");
    expect(html).toContain("<strong");
    expect(html).toContain("<code");
    expect(html).toContain("&lt;b&gt;raw&lt;/b&gt;");
    expect(html).toContain("<pre");
  });
});
