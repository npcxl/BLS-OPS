import { describe, expect, it } from "vitest";
import { createStreamFilter, visibleStream } from "../chat-actions";

/**
 * 把同一段原文按给定分片长度切开喂给过滤器，返回上屏文本。
 * 分片长度会循环使用（长度表为空时按 1 字符切）。
 */
function stream(raw: string, sizes: number[]): string {
  const filter = createStreamFilter();
  const pattern = sizes.length > 0 ? sizes : [1];
  let out = "";
  let at = 0;
  let index = 0;
  while (at < raw.length) {
    const size = pattern[index % pattern.length];
    index += 1;
    const chunk = raw.slice(at, at + size);
    at += size;
    out += filter.push(chunk);
  }
  return out + filter.finish();
}

/** 固定种子的伪随机：分片长度不可复现的话，失败信息就没法对照。 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomSizes(seed: number, count: number): number[] {
  const next = seeded(seed);
  return Array.from({ length: count }, () => 1 + Math.floor(next() * 5));
}

/**
 * 样本：每条都要覆盖"被切开就出错"的位置。
 *
 * 差分测试的断言只有一个 —— 分片流式过滤 == 一次性过滤。样本本身挑选的是
 * 真实模型会吐出来的东西：工具块、平台标记、代码块、被截断的结尾。
 */
const SAMPLES: { name: string; raw: string }[] = [
  {
    name: "跨片工具块",
    raw: '先看一眼内核：<tool name="run_shell">{"command":"uname -a"}</tool>是 5.15 的，继续。',
  },
  {
    name: "跨片动作标记",
    raw: "好的，我把附件传上去 [[up" + "load]] 然后再说，稍等。",
  },
  {
    name: "动作标记紧贴正文",
    raw: "结论：磁盘够用[[start]]已经可以开始了。",
  },
  {
    name: "面板标记在正文中间",
    raw: "日志在 [[panel:logs:/var/log/nginx/access.log]] 这里，我给你打开。",
  },
  {
    name: "正文中间夹代码块",
    raw: "## 步骤\n\n先跑一次：\n\n```bash\nuname -a\n\nls -la /var/www\n```\n\n然后看输出。\n\n结束。",
  },
  {
    name: "被截断的工具块",
    raw: '我先读一下配置：<tool name="read_file">{"path":"/etc/nginx/nginx.conf"',
  },
  {
    name: "被截断的标记开头",
    raw: "接下来我要调用 <|im_st",
  },
  {
    name: "被截断的动作半截",
    raw: "准备好就上传 [[upl",
  },
  {
    name: "连续空行与行尾空白",
    raw: "第一段\n\n\n\n第二段  \n\n c \n\n",
  },
  {
    name: "开头带空白",
    raw: "\n\n  先说结论：这台机子没问题。",
  },
  {
    name: "尖括号普通文本",
    raw: "比较一下 a < b 与 a<b，还有 1 <t 这种写法不算标记。",
  },
  {
    name: "工具块夹在两段空行之间",
    raw: '第一段。\n\n<tool name="run_shell">{"command":"uname -a"}</tool>\n\n第二段。',
  },
  {
    name: "长回复（工具块 + 代码块收尾）",
    raw: (() => {
      const block =
        "## 第 {{n}} 段\n\n先说结论：这一段的检查都通过了，没有发现问题。\n\n- 磁盘余量充足\n- 端口监听正常\n- 服务状态 active\n\n";
      let text = "";
      for (let index = 0; index < 40; index += 1) text += block.replace("{{n}}", String(index));
      return (
        text +
        '<tool name="run_shell">{"command":"uname -a && df -h"}</tool>' +
        "\n\n```bash\nuname -a\nLinux web-01 5.15.0\n```\n\n全部完成。"
      );
    })(),
  },
];

describe("流式增量过滤（与 visibleStream 差分）", () => {
  for (const sample of SAMPLES) {
    it(`${sample.name}：1/2/3 字符分片都能还原`, () => {
      const expected = visibleStream(sample.raw);
      for (const size of [1, 2, 3]) {
        expect(stream(sample.raw, [size]), `分片 ${size} 字符`).toBe(expected);
      }
    });

    it(`${sample.name}：随机分片（1~5 字符）都能还原`, () => {
      const expected = visibleStream(sample.raw);
      for (const seed of [7, 42, 20261118]) {
        expect(stream(sample.raw, randomSizes(seed, 64)), `seed ${seed}`).toBe(expected);
      }
    });
  }
});

describe("流式增量过滤的边界行为", () => {
  it("`<tool>` 块被切开时不泄漏参数", () => {
    const filter = createStreamFilter();
    const pushed =
      filter.push('看这里<tool name="run_shell">{"command"') +
      filter.push(': "rm -rf /tmp/x"}</tool>好');
    expect(pushed).not.toContain("run_shell");
    expect(pushed).not.toContain("rm -rf");
    expect(`${pushed}${filter.finish()}`).toBe(visibleStream(
      '看这里<tool name="run_shell">{"command": "rm -rf /tmp/x"}</tool>好',
    ));
  });

  it("工具块被删掉后，前后空行不会变成四行", () => {
    const raw = '第一段。\n\n<tool name="run_shell">{}</tool>\n\n第二段。';
    expect(visibleStream(raw)).toBe("第一段。\n\n第二段。");
    expect(stream(raw, [1])).toBe("第一段。\n\n第二段。");
    expect(stream(raw, [7])).toBe("第一段。\n\n第二段。");
  });

  it("普通正文边到边上屏，不压到结束才吐", () => {
    const filter = createStreamFilter();
    const first = filter.push("第一段文字已经足够长了，可以开始上屏。");
    expect(first.length).toBeGreaterThan(0);
  });

  it("一直不闭合的半个标记不会无限缓存", () => {
    const filter = createStreamFilter();
    const out = filter.push(`[[${"a".repeat(700)}`);
    expect(out.length).toBeGreaterThan(0);
  });

  it("finish 只吐一次，尾巴里的半个标记被丢掉", () => {
    const filter = createStreamFilter();
    const pushed = filter.push("结果如下：invoke name");
    expect(pushed).toBe("结果如下：");
    expect(filter.finish()).toBe("");
    expect(filter.finish()).toBe("");
  });
});
