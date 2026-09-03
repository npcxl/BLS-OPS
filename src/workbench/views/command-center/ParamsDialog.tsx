import { useState } from "react";
import { RISK_META, type CommandParams, type CommandSearchHit } from "@/api/ops-api";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { paramLabel, placeholderFor } from "./params";

/**
 * 参数编辑弹窗：需要参数的命令（docker logs <容器> / systemctl status <unit> /
 * git status <路径>）在执行前收集结构化参数。
 *
 * 修改型命令（medium）的执行按钮用 danger 色强调"会产生副作用"；只读命令
 * 用 primary。实际执行的命令由后端白名单生成并回显在结果里。
 */
export function ParamsDialog({
  hit,
  onSubmit,
  onCancel,
}: {
  hit: CommandSearchHit;
  onSubmit: (params: CommandParams) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const meta = RISK_META[hit.risk];
  const danger = hit.mutability !== "read";
  const complete = hit.required_params.every((name) => values[name]?.trim());

  return (
    <Modal open width={400} title={hit.title} onClose={onCancel}>
      <div className="flex flex-col gap-2.5">
        <p className="text-12 leading-relaxed text-fg-muted">{hit.description}</p>
        {hit.required_params.map((name) => (
          <label key={name} className="flex flex-col gap-1">
            <span className="text-11 text-fg-muted">{paramLabel(name)}</span>
            <input
              autoFocus
              value={values[name] ?? ""}
              onChange={(event) =>
                setValues((current) => ({ ...current, [name]: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && complete) onSubmit(toParams(hit, values));
              }}
              placeholder={placeholderFor(hit, name)}
              spellCheck={false}
              className="h-[28px] rounded-[6px] border border-line bg-surface-2 px-2 font-mono text-12 text-fg outline-none focus:border-accent"
            />
          </label>
        ))}
        <div className="flex items-center gap-1.5">
          <span className={danger ? "rounded bg-warning/12 px-1.5 py-0.5 text-10 text-warning" : "rounded bg-success/12 px-1.5 py-0.5 text-10 text-success"}>
            {meta.label}
          </span>
          <code className="min-w-0 flex-1 truncate font-mono text-10 text-fg-subtle" title={hit.syntax}>
            {hit.syntax}
          </code>
        </div>
        <p className="text-10 text-fg-subtle">
          实际执行的命令由白名单生成，并在结果里如实回显；参数会经过安全校验。
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            size="sm"
            disabled={!complete}
            onClick={() => onSubmit(toParams(hit, values))}
          >
            {danger ? "确认执行" : "执行"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function toParams(hit: CommandSearchHit, values: Record<string, string>): CommandParams {
  const params: CommandParams = {};
  for (const name of hit.required_params) {
    const value = values[name]?.trim();
    if (!value) continue;
    if (name === "container") params.container = value;
    else if (name === "unit") params.unit = value;
    else if (name === "path") params.path = value;
    else if (name === "lines") params.lines = Number(value);
  }
  return params;
}
