/** Only an explicit, standalone request can add long-term memory automatically. */
export function explicitMemory(text: string): { scope: "global" | "server" | "conversation"; content: string } | null {
  const raw = text.trim();
  const declaredPreference = raw.match(/^(?:我(?:更)?(?:习惯|喜欢|偏好)|(?:我希望)?以后(?:请|都|默认)|I (?:prefer|usually use)\b)([^\n？?。！!]{2,200})[。！!]?$/i);
  if (declaredPreference) return { scope: "global", content: raw };
  const match = raw.match(/^(?:(全局|本服务器|本对话|globally|this server|this conversation)\s*)?(?:请\s*|please\s+)?(?:记住|记下|remember)(?:\s*[：:]\s*|\s+|(?=以后|我|这个))([^\n？?]+)$/i);
  if (!match) return null;
  const content = match[2].trim();
  if (!content || Array.from(content).length > 800) return null;
  const qualifier = match[1]?.toLowerCase();
  return { scope: qualifier === "本服务器" || qualifier === "this server" ? "server" : qualifier === "本对话" || qualifier === "this conversation" ? "conversation" : "global", content };
}
