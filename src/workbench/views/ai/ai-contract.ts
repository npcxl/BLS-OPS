/**
 * AI 模块的**接口类型占位** —— 到此为止，不开发。
 *
 * # 范围（明确边界）
 *
 * 本轮 P4 只保留三样东西：
 * 1. 菜单入口占位（`NavigationRail` 的「智能助手」+ `Ctrl+J`）；
 * 2. feature flag（`AI_MODULE_ENABLED`，默认关闭）；
 * 3. 这里的接口类型占位。
 *
 * **不实现**：模型接入、Prompt、聊天界面、自动执行命令、任何网络调用。
 * 类型定义不产生运行时行为，也不会让任何命令绕开人工确认。
 *
 * 真要开发时（P5+），这里的类型就是前后端契约的起点；在此之前它们只是
 * 占位，**任何实现文件都不应出现在 `src/workbench/views/ai/` 之外**。
 */

/** AI 能力开关（默认全部关闭 —— 没有任何能力可用）。 */
export interface AiCapabilities {
  /** 解释一段终端输出。 */
  explainOutput: boolean;
  /** 根据自然语言生成命令（**仍然必须人工确认后才执行**）。 */
  suggestCommand: boolean;
  /** 对话式运维。 */
  chat: boolean;
}

/** 默认的"没有任何能力"—— 与安全边界一致：不接模型就不许声称有。 */
export const NO_AI_CAPABILITIES: AiCapabilities = {
  explainOutput: false,
  suggestCommand: false,
  chat: false,
};

/** 一次"解释输出"请求的形状（占位，暂不发送）。 */
export interface AiExplainRequest {
  /** 原始命令（用户真实执行过的）。 */
  command: string;
  /** 原始 stdout（**永不脱敏前发送** —— 未开发，仅定义）。 */
  stdout: string;
  /** 原始 stderr。 */
  stderr: string;
  exitCode: number | null;
}

/** 一次"解释输出"响应的形状（占位）。 */
export interface AiExplainResponse {
  summary: string;
  /** 建议的下一步命令 —— **仅供展示，绝不会被自动执行**。 */
  suggestedCommands: string[];
}

/** 模型提供方的配置形状（占位，当前不读取任何密钥）。 */
export interface AiProviderConfig {
  id: string;
  label: string;
  /** 例如 `https://api.example.com/v1`（当前无默认值）。 */
  baseUrl: string;
  model: string;
}
