import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  commitHistory,
  createHistory,
  redoHistory,
  resetHistory,
  undoHistory,
} from "../grid/edit-history";

describe("待提交修改的撤销/重做", () => {
  it("初始状态没有可撤销/可重做的步骤", () => {
    const state = createHistory<string[]>(["a"]);
    expect(canUndo(state)).toBe(false);
    expect(canRedo(state)).toBe(false);
    expect(state.present).toEqual(["a"]);
  });

  it("撤销回到上一个快照，重做再回到最新", () => {
    let state = createHistory<string[]>(["a"]);
    state = commitHistory(state, ["a", "b"]);
    state = commitHistory(state, ["a", "b", "c"]);
    expect(state.present).toEqual(["a", "b", "c"]);

    state = undoHistory(state);
    expect(state.present).toEqual(["a", "b"]);
    state = undoHistory(state);
    expect(state.present).toEqual(["a"]);
    expect(canUndo(state)).toBe(false);

    state = redoHistory(state);
    expect(state.present).toEqual(["a", "b"]);
    state = redoHistory(state);
    expect(state.present).toEqual(["a", "b", "c"]);
    expect(canRedo(state)).toBe(false);
  });

  it("引用不变的提交不产生撤销点", () => {
    const start = ["a"];
    const state = commitHistory(createHistory(start), start);
    expect(canUndo(state)).toBe(false);
  });

  it("新提交清空重做栈", () => {
    let state = createHistory<string[]>(["a"]);
    state = commitHistory(state, ["a", "b"]);
    state = undoHistory(state);
    expect(canRedo(state)).toBe(true);
    state = commitHistory(state, ["a", "z"]);
    expect(canRedo(state)).toBe(false);
    expect(state.present).toEqual(["a", "z"]);
  });

  it("历史长度有上限，不会无限增长", () => {
    let state = createHistory<number[]>([0]);
    for (let index = 1; index <= 80; index += 1) {
      state = commitHistory(state, [index], 10);
    }
    expect(state.past).toHaveLength(10);
    expect(state.present).toEqual([80]);
  });

  it("提交成功后重置历史（不能把已落库的改动撤回队列）", () => {
    let state = createHistory<string[]>(["a"]);
    state = commitHistory(state, ["a", "b"]);
    const reset = resetHistory(state, []);
    expect(reset.present).toEqual([]);
    expect(canUndo(reset)).toBe(false);
    expect(canRedo(reset)).toBe(false);
  });

  it("空的撤销/重做是幂等的", () => {
    const state = createHistory<string[]>(["a"]);
    expect(undoHistory(state)).toBe(state);
    expect(redoHistory(state)).toBe(state);
  });
});
