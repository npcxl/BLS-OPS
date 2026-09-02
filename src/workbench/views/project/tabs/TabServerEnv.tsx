import { Server } from "lucide-react";
import type {
  DeploymentInstance,
  ServerCapabilityProfile,
} from "@/api/ops-api";
import { InstanceList } from "../InstanceList";
import { CapabilityGraph, RuntimeComposition } from "../graphs";

/**
 * 服务器环境 tab：服务器的操作系统 / 已安装能力 / 运行形态 / 部署实例。
 * 这一屏信息量大，默认折叠在独立 tab 里，不挤占主项目列表。
 */
export function TabServerEnv({
  profile,
  instances,
}: {
  profile: ServerCapabilityProfile | null;
  instances: DeploymentInstance[];
}) {
  if (!profile && instances.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
        <Server size={28} className="text-fg-subtle" />
        <p className="text-12 text-fg-subtle">没有可用的服务器环境信息</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {profile && <CapabilityGraph profile={profile} />}
      <RuntimeComposition instances={instances} />
      <InstanceList instances={instances} />
    </div>
  );
}
