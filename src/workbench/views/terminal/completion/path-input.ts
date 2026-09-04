/**
 * 命令行切分 + 远程路径解析 —— **全部纯函数，零 I/O**，cd 补全的正确性都在这里。
 *
 * 三件事：
 * 1. `parseLine`：按 shell 规则切 token（单/双引号、反斜杠转义），并定位
 *    **光标所在的那个 token**（不是整行结尾 —— `docker logs -f web <cursor>`
 *    与 `docker logs <cursor> -f web` 必须给出不同的补全）；
 * 2. `analyzePathInput`：把用户敲到一半的路径拆成"要列哪个目录" +
 *    "还要补哪一段"，支持绝对路径、`~/`、`../`、带空格与引号的路径；
 * 3. `quotePathSegment`：把远程返回的目录名变成**能安全写进 shell 的文本**。
 *
 * 铁律：解析出来的用户路径只用于**列目录请求**（或拼接成列目录请求），
 * 绝不原样拼进命令行；写回 shell 的一律经过 `quotePathSegment`。
 */

import type { LineToken, ParsedLine } from "./types";

const SAFE_CHARS = /^[A-Za-z0-9_./@+=:,-]*$/;

// -- 切分 -------------------------------------------------------------------

/**
 * 按 shell 规则切分一行（不做变量展开、不做 glob —— 这里只要 token 边界）。
 *
 * 引号内的空格不分隔；反斜杠转义下一个字符。未闭合的引号不构成错误：
 * 用户正在输入 `"my dir/` 就是这种中间状态。
 */
export function tokenize(line: string): LineToken[] {
  const tokens: LineToken[] = [];
  let i = 0;

  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i += 1;
    if (i >= line.length) break;

    const start = i;
    let raw = "";
    let value = "";
    let quote: string | null = null;

    while (i < line.length) {
      const char = line[i];
      if (quote === null && /\s/.test(char)) break;
      raw += char;
      if (char === "\\" && i + 1 < line.length) {
        // 转义：保留原文（shell 需要它），value 里去掉反斜杠。
        raw += line[i + 1];
        value += line[i + 1];
        i += 2;
        continue;
      }
      if (quote !== null) {
        if (char === quote) quote = null;
        else value += char;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else {
        value += char;
      }
      i += 1;
    }

    tokens.push({ raw, value, start, end: i });
  }

  return tokens;
}

/**
 * 解析整行 + 光标位置。
 *
 * 光标落在某个 token 内部（含紧接其右）→ 补全那个 token；
 * 光标落在空白上（或行尾紧跟空格）→ 一个新的空 token。
 */
export function parseLine(line: string, cursor: number): ParsedLine {
  const safeCursor = Math.max(0, Math.min(cursor, line.length));
  const tokens = tokenize(line);
  const command = tokens[0]?.value ?? "";

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (safeCursor >= token.start && safeCursor <= token.end) {
      return {
        command,
        tokens,
        index,
        token,
        prefix: token.raw.slice(0, safeCursor - token.start),
      };
    }
  }

  return { command, tokens, index: tokens.length, token: null, prefix: "" };
}

// -- 路径解析 ---------------------------------------------------------------

/** 目录请求：去引号后的绝对路径 + 目录内的待补全片段。 */
export interface PathInput {
  /** 要列目录的绝对路径（已归一化）。 */
  dir: string;
  /** 目录内待补全的片段（去引号、去转义）。 */
  partial: string;
  /** 未闭合的引号（`"my dir/` → `"`）；没有则为 null。 */
  quote: string | null;
  /** 是否要显示隐藏项（只有输入以 `.` 开头才显示）。 */
  showHidden: boolean;
  /** `~/` 等需要家目录但家目录未知 → true（调用方应提示，绝不猜）。 */
  needsHome: boolean;
}

/** 去掉反斜杠转义：`my\ dir` → `my dir`。 */
export function unescapePath(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && i + 1 < text.length) {
      out += text[i + 1];
      i += 1;
    } else {
      out += text[i];
    }
  }
  return out;
}

/** POSIX 路径归一化：折叠 `//`、解析 `.` 与 `..`，保留前导 `/`。 */
export function normalizeRemotePath(path: string): string {
  const absolute = path.startsWith("/");
  const segments = path.split("/");
  const out: string[] = [];

  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // 根目录之上还是根目录（`cd /..` → `/`）。
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }

  if (absolute) return `/${out.join("/")}`;
  return out.length > 0 ? out.join("/") : ".";
}

/** 拼接远程路径（base 为空或相对时按相对处理）。 */
export function joinRemotePath(base: string, child: string): string {
  if (child.startsWith("/")) return child;
  if (base === "" || base === ".") return child === "" ? "." : child;
  if (child === "") return base;
  return `${base.replace(/\/+$/, "")}/${child}`;
}

/**
 * 把"用户敲到一半的路径片段"解析成目录请求。
 *
 * 只解析**光标之前的**文本（`prefix`），所以 `cd opt/<cursor>` 得到
 * `dir = <cwd>/opt`、`partial = ""` —— 下一步就列 `opt` 的子目录。
 *
 * 返回 `null` 表示无法确定目录（cwd 未知 / 家目录未知），调用方必须给用户
 * 一个可见说明，**不能退回本地文件系统**。
 */
export function analyzePathInput(
  prefix: string,
  cwd: string | null,
  home: string | null,
): PathInput | null {
  let text = prefix;

  // 未闭合的引号：剥掉开头那个，剩下的按字面处理（里面可能有空格）。
  let quote: string | null = null;
  const first = text[0];
  if (first === '"' || first === "'") {
    const closing = text.indexOf(first, 1);
    if (closing === -1) {
      quote = first;
      text = text.slice(1);
    }
  }

  let rest = text;
  let base: string;

  if (rest.startsWith("~/") || rest === "~") {
    // `cd ~` / `cd ~/x` → 家目录。`~user` 形式不支持：那要查 /etc/passwd，
    // 猜出来的路径是错的，宁可不给补全。
    if (rest.length > 1 && rest[1] !== "/") return null;
    if (home === null) {
      return { dir: "", partial: "", quote, showHidden: false, needsHome: true };
    }
    base = home;
    rest = rest === "~" ? "" : rest.slice(2);
  } else if (rest.startsWith("/")) {
    base = "/";
    rest = rest.slice(1);
  } else {
    if (cwd === null) return null;
    base = cwd;
  }

  // 单引号内没有转义；双引号内保留 `$` 等，但路径里按字面处理。
  const raw = quote === "'" ? rest : unescapePath(rest);
  const cut = raw.lastIndexOf("/");
  const dirPart = cut === -1 ? "" : raw.slice(0, cut + 1);
  const partial = cut === -1 ? raw : raw.slice(cut + 1);

  let dir = normalizeRemotePath(joinRemotePath(base, dirPart));
  if (dir === "") dir = "/";

  return {
    dir,
    partial,
    quote,
    showHidden: partial.startsWith("."),
    needsHome: false,
  };
}

// -- 写回 shell -------------------------------------------------------------

/**
 * 把远程返回的目录/文件名变成能安全写进 shell 的文本。
 *
 * - 只含安全字符 → 原样（最常见的 `opt` 不该变成 `"opt"`）；
 * - 含空格或 shell 元字符 → 双引号包裹并转义 `\ " $ ` ` `；
 * - 处在单引号里（用户敲了 `'my dir/`）→ 改用反斜杠转义，因为单引号里
 *   的双引号只是普通字符。
 *
 * `trailingSlash` 用于目录：引号要包在斜杠**外面**（`"my dir"/`，不是
 * `"my dir/"`），否则补全后继续按 `/` 会在引号外产生怪路径。
 */
export function quotePathSegment(name: string, quote: string | null, trailingSlash = false): string {
  const slash = trailingSlash ? "/" : "";
  if (SAFE_CHARS.test(name)) return `${name}${slash}`;

  if (quote === "'") {
    // 已经处在未闭合的单引号里：单引号内的反斜杠不是转义字符，唯一要处理的
    // 是单引号本身 —— 关引号 + 转义的引号 + 重新开引号（`'\''`）。
    return `${name.replace(/'/g, "'\\''")}${slash}`;
  }
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
  return `"${escaped}"${slash}`;
}

/** 候选的相对展示路径（相对于当前目录），列不出来时用绝对路径。 */
export function displayRelativePath(dir: string, name: string, cwd: string | null): string {
  const full = joinRemotePath(dir, name);
  if (cwd && full.startsWith(`${cwd.replace(/\/+$/, "")}/`)) {
    const relative = full.slice(cwd.replace(/\/+$/, "").length + 1);
    return `./${relative}`;
  }
  return full;
}
