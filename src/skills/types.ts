export interface SkillDefinition {
  name: string;
  description: string;
  version: string;
  requires?: {
    bins?: string[];
    env?: string[];
  };
  always: boolean;
  /**
   * Files listed here are read from disk every LLM call and injected into the
   * system prompt — survives summarization. Supports {today}/{yesterday}/{userId}.
   * See docs/superpowers/specs/2026-05-14-pinned-skill-state-design.md.
   */
  pinned: string[];
  complexity?: {
    simple?: TierConfig;
    medium?: TierConfig;
    complex?: TierConfig;
  };
  instructions: string;
  location: string;
}

export interface TierConfig {
  maxIterations: number;
  pattern?: 'single' | '3x3' | 'qa_loop' | 'checkpoint';
}

export interface SkillSummary {
  name: string;
  description: string;
  isAlwaysLoaded: boolean;
  location: string;
}
