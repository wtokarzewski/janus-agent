export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Content block for multimodal tool results (images from browser screenshots, etc.) */
export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** Content block for multimodal user messages (images from Telegram, etc.) */
export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentBlock[] }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string | ToolContentBlock[] };

/** Helper: wrap a text string as a content block array with an image. */
export function toolResultWithImage(text: string, base64: string, mediaType = 'image/png'): ToolContentBlock[] {
  return [
    { type: 'text', text },
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
  ];
}

/** Extract text from user message content (handles both string and multimodal blocks). */
export function userContentText(content: string | UserContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join(' ');
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  temperature?: number;
  maxTokens?: number;
  thinking?: { type: 'enabled'; budgetTokens: number };
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Split system prompt for Anthropic prompt caching: static part (cached) + dynamic part (uncached). */
  systemParts?: { staticPart: string; dynamicPart: string };
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: 'stop' | 'tool_calls' | 'length';
  thinkingContent?: string;
  /** Provider name that produced this response (set by ProviderRegistry). */
  provider?: string;
  /** Model ID that produced this response (set by ProviderRegistry). */
  model?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StreamCallback = (chunk: string) => void;

export interface LLMProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream?(request: ChatRequest, onChunk: StreamCallback): Promise<ChatResponse>;
}

export interface ProviderEntry {
  /** Registration label — unique per entry (a slot may decorate the provider name). */
  name: string;
  /**
   * Base provider name from config. Several entries (default slot, background
   * slot) can share one upstream; health state is keyed by this, never by `name`.
   */
  providerName: string;
  provider: LLMProvider;
  model: string;
  purpose: string[];
  priority: number;
  logLevel?: 'minimal' | 'normal' | 'verbose';
}
