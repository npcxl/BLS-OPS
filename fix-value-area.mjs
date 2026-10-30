import fs from "node:fs";
const f = "src/workbench/views/database/redis/RedisKeyDetail.tsx";
let s = fs.readFileSync(f, "utf8");
const a = '        <FormRow label={t("值:")} align="start" grow>\n';
if (!s.includes(a)) throw new Error("anchor a");
s = s.replace(
  a,
  a +
    '          <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-1.5 overflow-y-auto">\n',
);
const b = '        </FormRow>\n\n        <FormRow label="TTL:">';
if (!s.includes(b)) throw new Error("anchor b");
s = s.replace(b, "          </div>\n" + b);

// 成员列表统一拉满：Set/Hash 的根容器补 w-full（缺则加）。
s = s.replace(
  /function (SetEditor|HashEditor)\(\{[\s\S]*?\n  return \(\n    <div className="flex flex-col gap-1\.5">/g,
  (match, name) =>
    match.replace('<div className="flex flex-col gap-1.5">', '<div className="flex w-full min-w-0 flex-col gap-1.5">'),
);

fs.writeFileSync(f, s);
console.log("ok");
