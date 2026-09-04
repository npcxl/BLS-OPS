import { describe, expect, it } from "vitest";

import {
  analyzePathInput,
  displayRelativePath,
  joinRemotePath,
  normalizeRemotePath,
  parseLine,
  quotePathSegment,
  tokenize,
  unescapePath,
} from "./path-input";

/**
 * cd 补全的正确性全在这些纯函数里：
 * 切分（引号/转义）、"要列哪个目录 + 还要补哪一段"、以及写回 shell 的转义。
 */

describe("tokenize", () => {
  it("splits on unquoted whitespace", () => {
    const tokens = tokenize("cd /var/log");
    expect(tokens).toHaveLength(2);
    expect(tokens[0].value).toBe("cd");
    expect(tokens[1].value).toBe("/var/log");
  });

  it("keeps spaces inside quotes but strips the quotes from value", () => {
    const tokens = tokenize('cd "my dir/docs"');
    expect(tokens).toHaveLength(2);
    expect(tokens[1].value).toBe("my dir/docs");
    // raw 保留原文：替换范围要以原始偏移计算。
    expect(tokens[1].raw).toBe('"my dir/docs"');
  });

  it("keeps single-quoted text verbatim", () => {
    expect(tokenize("cat 'a b'")[1].value).toBe("a b");
  });

  it("unwraps backslash escapes in value but keeps raw", () => {
    const tokens = tokenize("cd my\\ dir");
    expect(tokens[1].value).toBe("my dir");
    expect(tokens[1].raw).toBe("my\\ dir");
  });

  it("collapses repeated whitespace", () => {
    expect(tokenize("cd    opt")).toHaveLength(2);
  });
});

describe("parseLine", () => {
  it("targets the token under the cursor, not the end of the line", () => {
    // `docker logs <cursor> -f` ：光标在中间，补全的是容器名而不是 `-f`。
    const parsed = parseLine("docker logs -f", 12);
    expect(parsed.index).toBe(2);
    expect(parsed.token?.value).toBe("-f");
    expect(parsed.prefix).toBe("");
  });

  it("reports a fresh empty token right after a space", () => {
    const parsed = parseLine("cd ", 3);
    expect(parsed.index).toBe(1);
    expect(parsed.token).toBeNull();
    expect(parsed.prefix).toBe("");
  });

  it("gives the typed prefix inside the current token", () => {
    const parsed = parseLine("cd opt", 6);
    expect(parsed.index).toBe(1);
    expect(parsed.prefix).toBe("opt");
  });

  it("reads the command from the first token", () => {
    expect(parseLine("systemctl status nginx", 22).command).toBe("systemctl");
  });
});

describe("normalizeRemotePath", () => {
  it("resolves .. and . segments", () => {
    expect(normalizeRemotePath("/var/log/../www")).toBe("/var/www");
    expect(normalizeRemotePath("/var/./log")).toBe("/var/log");
    expect(normalizeRemotePath("/var//log")).toBe("/var/log");
  });

  it("never escapes the root", () => {
    expect(normalizeRemotePath("/..")).toBe("/");
    expect(normalizeRemotePath("/../..")).toBe("/");
  });

  it("keeps relative paths relative", () => {
    expect(normalizeRemotePath("opt/../var")).toBe("var");
    expect(normalizeRemotePath("../../srv")).toBe("../../srv");
  });
});

describe("joinRemotePath", () => {
  it("treats an absolute child as its own base", () => {
    expect(joinRemotePath("/root", "/var")).toBe("/var");
  });

  it("joins relative children", () => {
    expect(joinRemotePath("/root", "opt")).toBe("/root/opt");
    expect(joinRemotePath("/root/", "opt")).toBe("/root/opt");
  });

  it("returns the base for an empty child", () => {
    expect(joinRemotePath("/root", "")).toBe("/root");
  });
});

describe("unescapePath", () => {
  it("removes backslashes", () => {
    expect(unescapePath("my\\ dir")).toBe("my dir");
    expect(unescapePath("a\\\\b")).toBe("a\\b");
  });
});

describe("analyzePathInput", () => {
  const cwd = "/root";
  const home = "/root";

  it("lists the current directory for a bare `cd `", () => {
    expect(analyzePathInput("", cwd, home)).toMatchObject({ dir: "/root", partial: "" });
  });

  it("filters by the typed prefix inside the current directory", () => {
    expect(analyzePathInput("o", cwd, home)).toMatchObject({ dir: "/root", partial: "o" });
  });

  it("descends into the typed directory: `cd opt/` lists opt's children", () => {
    expect(analyzePathInput("opt/", cwd, home)).toMatchObject({ dir: "/root/opt", partial: "" });
  });

  it("resolves ../ to the parent directory", () => {
    expect(analyzePathInput("../", "/root/opt", home)).toMatchObject({ dir: "/root", partial: "" });
  });

  it("resolves ../../", () => {
    // /var/log/nginx 往上两级 = /var。
    expect(analyzePathInput("../../", "/var/log/nginx", home)).toMatchObject({
      dir: "/var",
      partial: "",
    });
  });

  it("supports absolute paths", () => {
    expect(analyzePathInput("/var/", cwd, home)).toMatchObject({ dir: "/var", partial: "" });
    expect(analyzePathInput("/va", cwd, home)).toMatchObject({ dir: "/", partial: "va" });
  });

  it("supports ~/ against the remote home", () => {
    expect(analyzePathInput("~/", cwd, "/home/deploy")).toMatchObject({
      dir: "/home/deploy",
      partial: "",
    });
    expect(analyzePathInput("~", cwd, "/home/deploy")).toMatchObject({
      dir: "/home/deploy",
      partial: "",
    });
  });

  it("asks for the home directory instead of guessing one", () => {
    expect(analyzePathInput("~/", cwd, null)).toMatchObject({ needsHome: true });
  });

  it("refuses to complete when the cwd is unknown", () => {
    expect(analyzePathInput("opt", null, home)).toBeNull();
  });

  it("handles paths with spaces inside double quotes", () => {
    expect(analyzePathInput('"my dir/', cwd, home)).toMatchObject({
      dir: "/root/my dir",
      partial: "",
      quote: '"',
    });
    expect(analyzePathInput('"my dir/x', cwd, home)).toMatchObject({
      dir: "/root/my dir",
      partial: "x",
      quote: '"',
    });
  });

  it("handles backslash-escaped spaces", () => {
    expect(analyzePathInput("my\\ dir/", cwd, home)).toMatchObject({
      dir: "/root/my dir",
      partial: "",
      quote: null,
    });
  });

  it("only shows hidden entries when the input starts with a dot", () => {
    expect(analyzePathInput("", cwd, home)?.showHidden).toBe(false);
    expect(analyzePathInput(".", cwd, home)?.showHidden).toBe(true);
    expect(analyzePathInput(".config/", cwd, home)?.showHidden).toBe(false);
    expect(analyzePathInput("/root/.", cwd, home)?.showHidden).toBe(true);
  });

  it("keeps an unclosed single quote", () => {
    expect(analyzePathInput("'my dir/", cwd, home)).toMatchObject({
      dir: "/root/my dir",
      quote: "'",
    });
  });
});

describe("quotePathSegment", () => {
  it("leaves safe names untouched", () => {
    expect(quotePathSegment("opt", null)).toBe("opt");
    expect(quotePathSegment("bls-nginx", null)).toBe("bls-nginx");
  });

  it("keeps the trailing slash outside the quotes so the next level can complete", () => {
    expect(quotePathSegment("opt", null, true)).toBe("opt/");
    expect(quotePathSegment("my dir", null, true)).toBe('"my dir"/');
  });

  it("escapes spaces, quotes, $ and backticks", () => {
    expect(quotePathSegment("my dir", null, false)).toBe('"my dir"');
    expect(quotePathSegment('we"ird', null, false)).toBe('"we\\"ird"');
    expect(quotePathSegment("$HOME", null, false)).toBe('"\\$HOME"');
    expect(quotePathSegment("a`b", null, false)).toBe('"a\\`b"');
  });

  it("escapes for an open single quote with the close-quote trick", () => {
    // 已经处在 `'…` 里面：单引号内的反斜杠不是转义字符。
    expect(quotePathSegment("plain", "'", false)).toBe("plain");
    expect(quotePathSegment("it's", "'", false)).toBe("it'\\''s");
  });
});

describe("displayRelativePath", () => {
  it("shows ./name for entries under the cwd", () => {
    expect(displayRelativePath("/root", "opt", "/root")).toBe("./opt");
  });

  it("falls back to the absolute path elsewhere", () => {
    expect(displayRelativePath("/var", "log", "/root")).toBe("/var/log");
  });
});
