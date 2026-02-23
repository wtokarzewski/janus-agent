export interface ExecutionRecord {
  task: string;
  duration: number;
  iterations: number;
  toolCalls: number;
  tokenUsage: number;
  outcome: 'success' | 'error' | 'max_iterations';
  timestamp: string;
}

export interface LearnerStorage {
  append(record: ExecutionRecord): Promise<void>;
  getAll(): Promise<ExecutionRecord[]>;
  getRecent(limit: number): Promise<ExecutionRecord[]>;
}
