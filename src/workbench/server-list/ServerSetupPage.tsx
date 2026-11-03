import { useDomainStore } from "@/stores/domain-store";
import { TerminalPicker } from "@/workbench/views/terminal/TerminalPicker";

export function ServerSetupPage({tabId}: {tabId: string}) {
  const servers = useDomainStore(state => state.servers);
  return <TerminalPicker tabId={tabId} servers={servers} initialMode="create" />;
}
