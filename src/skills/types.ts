export interface SkillDefinition {
  name: string;
  description: string;
  version: string;
  requires?: {
    bins?: string[];
    env?: string[];
  };
  always: boolean;
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
