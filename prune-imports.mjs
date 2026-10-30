// 按 tsc 的 TS6133/TS6196/TS6192 报错剪掉未使用的 import（只动 import 区，逻辑零改动）。
import { execSync } from "node:child_process";
import fs from "node:fs";

for (let round = 0; round < 4; round += 1) {
  let out = "";
  try {
    out = execSync("npx tsc --noEmit", { maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
  } catch (error) {
    out = String(error.stdout ?? "");
  }
  const lines = out.split(/\r?\n/).filter((line) => /error TS(6133|6196|6192)/.test(line));
  if (lines.length === 0) {
    console.log("clean after", round, "rounds");
    break;
  }
  const byFile = new Map();
  for (const line of lines) {
    const match = line.match(/^(.+?)\((\d+),\d+\): error TS(\d+): '(.+?)'/);
    if (!match) continue;
    const [, file, lineNo, code, name] = match;
    if (!fs.existsSync(file)) continue;
    const key = `${file}`;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push({ line: Number(lineNo), code, name });
  }
  for (const [file, entries] of byFile) {
    const content = fs.readFileSync(file, "utf8").split(/\r?\n/);
    // 从后往前删，避免行号漂移。
    entries
      .sort((a, b) => b.line - a.line)
      .forEach(({ line, code, name }) => {
        const index = line - 1;
        const text = content[index] ?? "";
        if (code === "6192") {
          // 整条 import 都没用了。
          let start = index;
          while (start > 0 && !/^import\b/.test(content[start])) start -= 1;
          let end = index;
          while (end < content.length - 1 && !/from\s+"/.test(content[end])) end += 1;
          content.splice(start, end - start + 1);
          return;
        }
        // 单个标识符：可能在同一行的 {a, b} 里。
        const pattern = new RegExp(`\\s*\\b${name.replace(/[$]/g, "\\$")}\\b,?`);
        const next = text.replace(pattern, "");
        if (next.trim() === "" || /^import\s*\{\s*\}\s*from/.test(next.trim())) {
          content[index] = "";
        } else {
          content[index] = next;
        }
      });
    fs.writeFileSync(file, content.join("\n"));
  }
  console.log("round", round, "pruned", byFile.size, "files");
}
