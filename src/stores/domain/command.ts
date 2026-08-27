/**
 * Command History & Quick Commands — spec §18.
 */

export type CommandSource = "user" | "quick-command" | "ai" | "script";

export interface CommandHistory {
  id: string;
  sessionId: string;
  serverId: string;
  serverName: string;
  command: string;
  timestamp: number;
  exitCode?: number;
  source: CommandSource;
  output?: string;
}

export interface QuickCommand {
  id: string;
  name: string;
  command: string;
  description?: string;
  groupId?: string;
  serverId?: string;
  createdAt: number;
}
