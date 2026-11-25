import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { opsApi } from "@/api/ops-api";
import type { AgentQuestion } from "@/api/types/agent";
import { useExtremeStore, type ExtremeMessage } from "@/stores/extreme-store";
import { QuestionCard } from "../QuestionCard";
import type { MessageQuestionPart } from "../message-parts";

function question(overrides: Partial<AgentQuestion> = {}): AgentQuestion {
  return {
    questionId: "q-1",
    taskId: "task-1",
    workspaceId: "w",
    serverId: "s",
    question: "查哪个环境？",
    kind: "single",
    options: [
      { id: "prod", label: "生产" },
      { id: "test", label: "测试" },
    ],
    allowCustom: true,
    deadline: Date.now() + 60_000,
    ...overrides,
  };
}

function part(
  overrides: Partial<MessageQuestionPart> = {},
  q: AgentQuestion = question(),
): MessageQuestionPart {
  return {
    kind: "question",
    id: `question-${q.questionId}`,
    taskId: q.taskId,
    question: q,
    status: "pending",
    draftSelected: [],
    draftCustom: "",
    draftCustomActive: false,
    answer: null,
    error: null,
    ...overrides,
  };
}

function mount(initial: MessageQuestionPart) {
  const message: ExtremeMessage = {
    id: "m-1",
    role: "assistant",
    text: "",
    taskId: initial.taskId,
    parts: [initial],
  };
  useExtremeStore.setState({
    workspaceId: "w",
    messages: [message],
    workspaces: [],
  });
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  function Harness() {
    const current = useExtremeStore((state) =>
      state.messages.find((item) => item.id === "m-1"),
    );
    const currentPart = current?.parts?.find(
      (item): item is MessageQuestionPart =>
        item.kind === "question" && item.question.questionId === initial.question.questionId,
    );
    return currentPart ? (
      <QuestionCard part={currentPart} messageId="m-1" />
    ) : null;
  }
  return { holder, root, Harness };
}

function currentPart(questionId = "q-1") {
  const message = useExtremeStore.getState().messages.find((item) => item.id === "m-1");
  return message?.parts?.find(
    (item): item is MessageQuestionPart =>
      item.kind === "question" && item.question.questionId === questionId,
  );
}

describe("AI 提问选择卡", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("单选可以改选，完成后原地显示已选内容", async () => {
    const answer = vi.spyOn(opsApi, "aiAgentAnswer").mockResolvedValue(true);
    const { holder, root, Harness } = mount(part());
    try {
      await act(async () => root.render(<Harness />));
      const testOption = holder.querySelector<HTMLButtonElement>(
        '[data-testid="question-option-test"]',
      )!;
      const prodOption = holder.querySelector<HTMLButtonElement>(
        '[data-testid="question-option-prod"]',
      )!;
      await act(async () => testOption.click());
      expect(currentPart()?.draftSelected).toEqual(["test"]);
      await act(async () => prodOption.click());
      expect(currentPart()?.draftSelected).toEqual(["prod"]);

      const submit = holder.querySelector<HTMLButtonElement>(
        '[data-testid="question-submit"]',
      )!;
      await act(async () => submit.click());
      expect(answer).toHaveBeenCalledWith("task-1", "q-1", ["prod"], null);
      expect(currentPart()?.status).toBe("answered");
      expect(holder.textContent).toContain("已回答");
      expect(holder.textContent).toContain("生产");
      expect(holder.querySelector('[data-testid="question-submit"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("仅自定义：聚焦输入，trim 后提交", async () => {
    const answer = vi.spyOn(opsApi, "aiAgentAnswer").mockResolvedValue(true);
    const q = question({ kind: "single", options: [], allowCustom: true });
    const { holder, root, Harness } = mount(part({}, q));
    try {
      await act(async () => root.render(<Harness />));
      const customToggle = holder.querySelector<HTMLButtonElement>(
        '[data-testid="question-custom-toggle"]',
      )!;
      await act(async () => customToggle.click());
      const input = holder.querySelector<HTMLInputElement>(
        '[data-testid="question-custom"]',
      )!;
      expect(document.activeElement).toBe(input);
      const submit = holder.querySelector<HTMLButtonElement>(
        '[data-testid="question-submit"]',
      )!;
      expect(submit.disabled).toBe(true);

      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(input, "  只看生产  ");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(submit.disabled).toBe(false);
      await act(async () => submit.click());
      expect(answer).toHaveBeenCalledWith("task-1", "q-1", [], "只看生产");
      expect(currentPart()?.status).toBe("answered");
      expect(holder.textContent).toContain("自定义：只看生产");
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("多选同时提交预设选项与自定义内容", async () => {
    const answer = vi.spyOn(opsApi, "aiAgentAnswer").mockResolvedValue(true);
    const q = question({ kind: "multi" });
    const { holder, root, Harness } = mount(part({}, q));
    try {
      await act(async () => root.render(<Harness />));
      await act(async () =>
        holder
          .querySelector<HTMLButtonElement>('[data-testid="question-option-prod"]')!
          .click(),
      );
      await act(async () =>
        holder
          .querySelector<HTMLButtonElement>('[data-testid="question-custom-toggle"]')!
          .click(),
      );
      const input = holder.querySelector<HTMLInputElement>(
        '[data-testid="question-custom"]',
      )!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(input, "另外看灰度");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () =>
        holder
          .querySelector<HTMLButtonElement>('[data-testid="question-submit"]')!
          .click(),
      );
      expect(answer).toHaveBeenCalledWith("task-1", "q-1", ["prod"], "另外看灰度");
      expect(currentPart()?.status).toBe("answered");
      expect(holder.textContent).toContain("生产");
      expect(holder.textContent).toContain("自定义：另外看灰度");
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("提交期间只发一次；失败保留选择并可重试", async () => {
    let resolveFirst!: (value: boolean) => void;
    const first = new Promise<boolean>((resolve) => {
      resolveFirst = resolve;
    });
    const answer = vi
      .spyOn(opsApi, "aiAgentAnswer")
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(true);
    const { holder, root, Harness } = mount(part());
    try {
      await act(async () => root.render(<Harness />));
      await act(async () =>
        holder
          .querySelector<HTMLButtonElement>('[data-testid="question-option-prod"]')!
          .click(),
      );
      const submit = holder.querySelector<HTMLButtonElement>(
        '[data-testid="question-submit"]',
      )!;
      await act(async () => submit.click());
      await act(async () => submit.click());
      expect(answer).toHaveBeenCalledTimes(1);
      await act(async () => resolveFirst(true));
      expect(currentPart()?.status).toBe("answered");
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("提交失败保留选择，重试成功后显示结果", async () => {
    const answer = vi
      .spyOn(opsApi, "aiAgentAnswer")
      .mockRejectedValueOnce(new Error("网络中断"))
      .mockResolvedValueOnce(true);
    const { holder, root, Harness } = mount(part());
    try {
      await act(async () => root.render(<Harness />));
      await act(async () =>
        holder
          .querySelector<HTMLButtonElement>('[data-testid="question-option-prod"]')!
          .click(),
      );
      await act(async () => holder.querySelector<HTMLButtonElement>(
        '[data-testid="question-submit"]',
      )!.click());
      expect(currentPart()?.status).toBe("failed");
      expect(currentPart()?.draftSelected).toEqual(["prod"]);
      expect(holder.textContent).toContain("网络中断");
      expect(holder.textContent).toContain("重试");

      await act(async () => holder.querySelector<HTMLButtonElement>(
        '[data-testid="question-submit"]',
      )!.click());
      expect(answer).toHaveBeenCalledTimes(2);
      expect(currentPart()?.status).toBe("answered");
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("已回答的历史卡只展示结果", async () => {
    const q = question();
    const { holder, root, Harness } = mount(
      part({
        status: "answered",
        answer: { selected: ["test"], custom: "补充说明" },
        draftSelected: ["test"],
      }),
    );
    try {
      await act(async () => root.render(<Harness />));
      expect(holder.textContent).toContain("已回答");
      expect(holder.textContent).toContain("测试");
      expect(holder.textContent).toContain("自定义：补充说明");
      expect(holder.querySelector('[data-testid="question-option-prod"]')).toBeNull();
      expect(holder.querySelector('[data-testid="question-submit"]')).toBeNull();
      void q;
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });
});
