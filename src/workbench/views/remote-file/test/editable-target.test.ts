import { describe, expect, it } from "vitest";
import { isEditableTarget } from "../utils";

function element(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as Element;
}

describe("isEditableTarget", () => {
  it("treats inputs, textareas and contenteditable as editable", () => {
    expect(isEditableTarget(element("<input />"))).toBe(true);
    expect(isEditableTarget(element("<textarea></textarea>"))).toBe(true);
    // CodeMirror 的编辑区：contenteditable 挂在容器上，事件落点是里面的 span。
    const cm = element('<div contenteditable="true"><span>x</span></div>');
    expect(isEditableTarget(cm.querySelector("span"))).toBe(true);
  });

  it("leaves ordinary panel content alone", () => {
    expect(isEditableTarget(element("<button>rename</button>"))).toBe(false);
    // contenteditable="false"（只读预览）不算编辑区。
    const readOnly = element('<div contenteditable="false"><span>x</span></div>');
    expect(isEditableTarget(readOnly.querySelector("span"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(document)).toBe(false);
  });
});
