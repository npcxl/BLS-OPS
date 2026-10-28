import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DbEngineIcon } from "../DbEngineIcon";

describe("DbEngineIcon", () => {
  it("renders the full 256x256 MySQL icon, not a clipped 16x16 fragment", () => {
    const html = renderToStaticMarkup(
      <DbEngineIcon engine="mysql" connected size={13} />,
    );
    expect(html).toContain("<svg");
    expect(html).toContain('viewBox="0 0 256 256"');
    expect(html).toContain('width="13"');
    expect(html).toContain("#00678c");
  });

  it("uses grayscale for a disconnected connection", () => {
    const html = renderToStaticMarkup(
      <DbEngineIcon engine="mysql" connected={false} size={13} />,
    );
    expect(html).toContain("grayscale");
  });
});
