/**
 * 基础控件约定的守卫测试（不引入 ESLint 规则，走现有 vitest 体系）。
 *
 * 背景：这套 UI 曾经同时存在三套下拉（原生 `<select>`、`Select`、
 * 手写 button+listbox）和三套输入框高度（22/24/26/30px）。靠人工 review
 * 拦不住，因为"再加一个原生下拉"看起来完全无害。这里把门关住：
 *
 * 1. 业务代码里不允许出现原生 `<select>` —— 一律用 `@/components/ui/select`；
 * 2. 不允许再引用 `selectClass*`（那是给原生 select 用的历史样式）；
 * 3. 不允许给 `Select` 传 `height` / `itemHeight`（尺寸必须走 size 档位）。
 *
 * 用 Vite 的 `import.meta.glob` 读源码，不依赖 Node 类型（项目没装 @types/node）。
 * 唯一的例外是 `src/components/ui/**`：公共控件实现自己要用原生元素。
 */
import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("/src/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 允许的例外：前缀 + 原因。加例外必须写清楚为什么。 */
const ALLOWED: Array<{ prefix: string; reason: string }> = [
  { prefix: "/src/components/ui/", reason: "公共控件实现目录" },
];

function businessSources(): Array<[string, string]> {
  return Object.entries(SOURCES).filter(
    ([path]) =>
      !/\.test\.tsx$/.test(path) &&
      !ALLOWED.some(({ prefix }) => path.startsWith(prefix)),
  );
}

function scan(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const [path, text] of businessSources()) {
    text.split(/\r?\n/).forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${path}:${index + 1}  ${line.trim()}`);
    });
  }
  return hits;
}

describe("基础控件约定", () => {
  it("业务代码不使用原生 <select>（统一走 Select）", () => {
    const hits = scan(/<select[\s>]/);
    expect(hits, `发现原生 <select>，请改用 @/components/ui/select：\n${hits.join("\n")}`).toEqual(
      [],
    );
  });

  it("业务代码不再引用 selectClass / selectClassSm", () => {
    const hits = scan(/\bselectClass(Sm)?\b/);
    expect(hits, `selectClass 只服务于原生 select，已废弃：\n${hits.join("\n")}`).toEqual([]);
  });

  it("Select 不接收 height / itemHeight 覆盖", () => {
    const hits: string[] = [];
    for (const [path, text] of businessSources()) {
      for (const block of text.match(/<Select\b[\s\S]*?\/>/g) ?? []) {
        if (/\b(height|itemHeight)\s*=/.test(block)) {
          hits.push(`${path}  ${block.replace(/\s+/g, " ").slice(0, 120)}`);
        }
      }
    }
    expect(hits, `Select 的尺寸必须走 size 档位，不要逐页写死：\n${hits.join("\n")}`).toEqual(
      [],
    );
  });
});
