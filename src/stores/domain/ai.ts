/**
 * AI domain — spec §84–§90.
 */

export type AiProvider = "local" | "openai" | "anthropic" | "azure" | "custom";

export interface AiProviderConfig {
  id: string;
  name: string;
  type: AiProvider;
  apiUrl?: string;
  apiKeyReference?: string; // Secret reference
  model: string;
  enabled: boolean;
  timeout: number;
  maxTokens: number;
}

export type AiConversationRole = "user" | "assistant" | "system";

export interface AiMessage {
  id: string;
  conversationId: string;
  role: AiConversationRole;
  content: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

export interface AiConversation {
  id: string;
  providerId: string;
  title: string;
  messages: AiMessage[];
  context?: {
    serverId?: string;
    projectId?: string;
    filePath?: string;
    command?: string;
    logContent?: string;
  };
  createdAt: number;
  updatedAt: number;
}

export interface AiProposal {
  id: string;
  type: "command" | "config" | "workflow" | "deployment" | "diagnosis";
  content: string;
  explanation?: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  riskExplanation?: string;
  suggestedActions: string[];
  createdAt: number;
}
