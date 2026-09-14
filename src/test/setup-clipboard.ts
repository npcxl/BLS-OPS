import { vi } from "vitest";

/**
 * 测试环境下的剪贴板替身。
 *
 * 生产代码走 `@tauri-apps/plugin-clipboard-manager`（Rust 侧读写，避开
 * WebView2 的原生权限弹窗），但该模块在 happy-dom 里没有 IPC 后端，调用
 * 必然失败。这里把它替换成**转发到 `navigator.clipboard`** 的实现。
 *
 * 为什么转发而不是自己存内存：既有测试普遍用
 * `vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(...)`
 * 来断言"复制失败要显示提示"。只有让生产调用真的落到那个对象上，这些
 * 用例才继续有效。mock 替身与真实实现在这里保持同一个可观测面。
 */
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: async (text: string) => navigator.clipboard.writeText(text),
  readText: async () => navigator.clipboard.readText(),
}));

// happy-dom 不提供剪贴板实现，补一个最小可用的（可被 vi.spyOn 覆盖）。
if (!navigator.clipboard) {
  const memory = { text: "" };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        memory.text = text;
      },
      readText: async () => memory.text,
    },
  });
}
