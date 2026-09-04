import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ModuleEmpty } from "@/workbench/views/module-frame";
import type { ServerCapabilityProfile } from "@/api/ops-api";
import { CapabilityGraph } from "../graphs";

/**
 * 基本信息 tab：只展示服务器能力图谱（操作系统 / 运行时 / 工具版本 /
 * Docker·Nginx 等是否安装 / 权限）。
 *
 * 刻意**不**列容器、也不放数量角标 —— 那些属于"运行服务"与"基础设施"，
 * 不该挤在这里。这一屏回答的是"这台机器是什么、能做什么收集"，与项目身份无关。
 */
export function TabBasicInfo({ profile }: { profile: ServerCapabilityProfile | null }) {
  const { t } = useTranslation();
  if (!profile) {
    return (
      <ModuleEmpty
        icon={Server}
        title={t("No server capability info")}
        hint={t(
          "Run a discovery first: it identifies the OS and installed capabilities, then enables matching collectors.",
        )}
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <CapabilityGraph profile={profile} />
    </div>
  );
}
