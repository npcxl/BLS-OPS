import { useWorkbenchStore } from "@/stores/workbench-store";

/** All new-server entry points open the same connection setup workspace. */
export function openNewServerTab(): void {
  useWorkbenchStore.getState().openTab({ id: crypto.randomUUID(), type: "server", title: "Add server" });
}
