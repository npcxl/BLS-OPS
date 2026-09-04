// 临时校验脚本：范围内组件的 t("...") 字面量 key 必须在语言包中存在。用后即删。
const fs = require("fs");
const files = [
  "src/workbench/AppTopBar.tsx",
  "src/workbench/WorkspaceTabs.tsx",
  "src/workbench/Workbench.tsx",
  "src/workbench/ContextSidebar.tsx",
  "src/workbench/NavigationRail.tsx",
  "src/workbench/ModulePage.tsx",
  "src/workbench/StatusBar.tsx",
  "src/workbench/command-palette.tsx",
  "src/workbench/empty-pane-state.tsx",
  "src/workbench/window-controls.tsx",
  "src/workbench/views/WorkbenchHome.tsx",
  "src/workbench/views/module-frame.tsx",
  "src/workbench/views/PlaceholderView.tsx",
  "src/workbench/views/FileEditorModal.tsx",
  "src/workbench/views/LogCenterView.tsx",
  "src/workbench/views/ServiceManagerView.tsx",
];
const pack = fs.readFileSync("src/i18n/locales/zh-CN/workbench.ts", "utf8");
const common = fs.readFileSync("src/i18n/locales/zh-CN/common.ts", "utf8");
const settings = fs.readFileSync("src/i18n/locales/zh-CN/settings.ts", "utf8");
let bad = [];
let total = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    total++;
    const raw = m[1];
    if (!pack.includes(raw) && !common.includes(raw) && !settings.includes(raw)) {
      bad.push(f + " :: " + raw);
    }
  }
}
console.log("checked literal keys:", total);
console.log(bad.length ? "MISSING:\n" + bad.join("\n") : "ALL KEYS PRESENT");
