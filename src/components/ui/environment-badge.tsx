/**
 * 服务器环境徽标：生产 / 预发 / 开发 / 未指定。
 *
 * `unspecified` 是"没说"，不是"安全" —— 它用中性灰，但**不会**被当成非生产
 * 隐藏起来：用户必须能一眼看出"这台机器还没标"。
 */
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import type { ServerEnvironment } from "@/api/types/servers";

export const ENVIRONMENT_LABEL: Record<ServerEnvironment, string> = {
  unspecified: "Not specified",
  production: "Production",
  staging: "Staging",
  development: "Development",
};

function tone(environment: ServerEnvironment): string {
  switch (environment) {
    case "production":
      return "bg-danger/12 text-danger";
    case "staging":
      return "bg-warning/12 text-warning";
    case "development":
      return "bg-success/12 text-success";
    default:
      return "bg-surface-2 text-fg-subtle";
  }
}

export function EnvironmentBadge({
  environment,
  className,
}: {
  environment: ServerEnvironment;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-10",
        tone(environment),
        className,
      )}
      title={t("Server environment: {{environment}}", {
        environment: t(ENVIRONMENT_LABEL[environment]),
      })}
    >
      {t(ENVIRONMENT_LABEL[environment])}
    </span>
  );
}
