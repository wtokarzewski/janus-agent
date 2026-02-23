export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

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
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: 'stop' | 'tool_calls' | 'length';
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type StreamCallback = (chunk: string) => void;

export interface LLMProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream?(request: ChatRequest, onChunk: StreamCallback): Promise<ChatResponse>;
}

export interface ProviderEntry {
  name: string;
  provider: LLMProvider;
  model: string;
  purpose: string[];
  priority: number;
}
