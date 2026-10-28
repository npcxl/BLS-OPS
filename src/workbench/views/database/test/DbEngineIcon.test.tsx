import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DbEngineIcon } from "../DbEngineIcon";

const theme = vi.hoisted(() => ({ mode: "light" as "light" | "dark" }));

vi.mock("@/hooks/use-theme", () => ({
  useThemeMode: () => [theme.mode, () => undefined],
}));

describe("DbEngineIcon", () => {
  beforeEach(() => {
    theme.mode = "light";
  });

  it("renders the full 256x256 icon, not a clipped 16x16 fragment", () => {
    const html = renderToStaticMarkup(
      <DbEngineIcon engine="mysql" connected size={13} />,
    );
    expect(html).toContain("<svg");
    expect(html).toContain('viewBox="0 0 256 256"');
    expect(html).toContain('width="13"');
    // 浅色界面用深色主体版本。
    expect(html).toContain("#242938");
  });

  it("uses the light icon on a dark theme", () => {
    theme.mode = "dark";
    const html = renderToStaticMarkup(
      <DbEngineIcon engine="mysql" connected size={13} />,
    );
    expect(html).toContain("#f4f2ed");
    expect(html).toContain("#00678c");
  });

  it("uses grayscale for a disconnected connection", () => {
    const html = renderToStaticMarkup(
      <DbEngineIcon engine="mysql" connected={false} size={13} />,
    );
    expect(html).toContain("grayscale");
  });
});
