export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type RunMode = "run" | "dry-run";

export interface ModelVariantConfig {
  /** Human-readable/provider-side model id sent to the endpoint. */
  model: string;
  /** A local name used only to identify this endpoint in the generated Pi catalog. */
  provider?: string;
  /** OpenAI-compatible endpoint base URL, including the /v1 suffix when required. */
  baseUrl: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  apiKeyEnv?: string;
  apiKey?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  samplingParams?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

export interface AgentConfig {
  systemPrompt: string;
  tools: string[];
  thinkingLevel: ThinkingLevel;
  maxTurns: number;
  timeoutMs: number;
  promptTemplate?: string;
}

export interface BenchmarkConfig {
  manifestPath: string;
  outputDir: string;
  repositories: Record<string, string>;
  variants: Record<string, ModelVariantConfig>;
  agent: AgentConfig;
  keepWorktrees?: boolean;
}

export interface BenchmarkInstance {
  instance_id: string;
  repo?: string;
  repo_dir?: string;
  base_commit?: string;
  problem_statement: string;
  [key: string]: unknown;
}

export type RunStatus = "completed" | "error" | "timeout" | "turn-limit" | "dry-run";

export interface RunResult {
  variant: string;
  instanceId: string;
  status: RunStatus;
  patch: string;
  artifactDir: string;
  turns: number;
  durationMs: number;
  error?: string;
}

export interface RunSummary {
  mode: RunMode;
  variants: string[];
  instances: string[];
  results: RunResult[];
  predictions: Record<string, string>;
}
