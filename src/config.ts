import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { BenchmarkConfig, ModelVariantConfig } from "./types.js";

interface JsonRecord {
  [key: string]: unknown;
}

export interface PiModelReference {
  provider: string;
  model: string;
}

export interface PiModelsCatalog {
  providers: Record<string, JsonRecord>;
  references: Record<string, PiModelReference>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function expandHome(pathValue: string): string {
  if (pathValue === "~") return process.env.HOME ?? pathValue;
  if (pathValue.startsWith("~/")) return join(process.env.HOME ?? "~", pathValue.slice(2));
  return pathValue;
}

function resolveConfigPath(baseDir: string, pathValue: string): string {
  const expanded = expandHome(pathValue);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(expanded)) return expanded;
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function interpolateString(value: string, field: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) throw new Error(`${field} references missing environment variable ${name}`);
    return resolved;
  });
}

function parseVariant(name: string, raw: unknown): ModelVariantConfig {
  if (!isRecord(raw)) throw new Error(`variants.${name} must be an object`);
  const model = requiredString(raw.model, `variants.${name}.model`);
  const baseUrl = requiredString(raw.baseUrl, `variants.${name}.baseUrl`);
  const api = raw.api;
  if (api !== undefined && api !== "openai-completions" && api !== "openai-responses" && api !== "anthropic-messages") {
    throw new Error(`variants.${name}.api is not a supported Pi API`);
  }
  const apiKeyEnv = raw.apiKeyEnv === undefined ? undefined : requiredString(raw.apiKeyEnv, `variants.${name}.apiKeyEnv`);
  if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error(`variants.${name}.apiKeyEnv must be an environment variable name`);
  }
  if (raw.apiKey !== undefined && typeof raw.apiKey !== "string") {
    throw new Error(`variants.${name}.apiKey must be a string`);
  }
  const input = raw.input;
  if (input !== undefined && (!Array.isArray(input) || input.some((item) => item !== "text" && item !== "image"))) {
    throw new Error(`variants.${name}.input must contain only text or image`);
  }

  const variant: ModelVariantConfig = {
    model: interpolateString(model, `variants.${name}.model`),
    baseUrl: interpolateString(baseUrl, `variants.${name}.baseUrl`),
    reasoning: optionalBoolean(raw.reasoning, `variants.${name}.reasoning`, true),
    contextWindow: optionalPositiveInteger(raw.contextWindow, `variants.${name}.contextWindow`, 131072),
    maxTokens: optionalPositiveInteger(raw.maxTokens, `variants.${name}.maxTokens`, 16384),
  };
  if (raw.provider !== undefined) variant.provider = requiredString(raw.provider, `variants.${name}.provider`);
  if (api !== undefined) variant.api = api;
  if (apiKeyEnv !== undefined) variant.apiKeyEnv = apiKeyEnv;
  if (raw.apiKey !== undefined) variant.apiKey = interpolateString(raw.apiKey as string, `variants.${name}.apiKey`);
  if (input !== undefined) variant.input = input as Array<"text" | "image">;
  const samplingParams = optionalRecord(raw.samplingParams, `variants.${name}.samplingParams`);
  if (samplingParams !== undefined) variant.samplingParams = samplingParams;
  const compat = optionalRecord(raw.compat, `variants.${name}.compat`);
  if (compat !== undefined) variant.compat = compat;
  return variant;
}

export function parseConfig(raw: unknown, configPath: string): BenchmarkConfig {
  if (!isRecord(raw)) throw new Error("benchmark config must be a JSON object");
  const baseDir = dirname(resolve(configPath));
  const manifestPath = resolveConfigPath(baseDir, requiredString(raw.manifestPath, "manifestPath"));
  const outputDir = resolveConfigPath(baseDir, requiredString(raw.outputDir, "outputDir"));

  if (!isRecord(raw.repositories)) throw new Error("repositories must be an object");
  const repositories: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw.repositories)) {
    repositories[name] = resolveConfigPath(baseDir, requiredString(value, `repositories.${name}`));
  }

  if (!isRecord(raw.variants) || Object.keys(raw.variants).length === 0) {
    throw new Error("variants must contain at least one model variant");
  }
  const variants: Record<string, ModelVariantConfig> = {};
  for (const [name, value] of Object.entries(raw.variants)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new Error(`variant name ${name} contains unsupported characters`);
    }
    variants[name] = parseVariant(name, value);
  }

  if (!isRecord(raw.agent)) throw new Error("agent must be an object");
  const tools = raw.agent.tools;
  if (!Array.isArray(tools) || tools.length === 0 || tools.some((tool) => typeof tool !== "string" || tool.length === 0)) {
    throw new Error("agent.tools must be a non-empty string array");
  }
  const thinkingLevel = raw.agent.thinkingLevel ?? "off";
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel as string)) {
    throw new Error("agent.thinkingLevel is invalid");
  }
  const systemPrompt = requiredString(raw.agent.systemPrompt, "agent.systemPrompt");
  const promptTemplate = raw.agent.promptTemplate === undefined
    ? undefined
    : requiredString(raw.agent.promptTemplate, "agent.promptTemplate");

  const agent: BenchmarkConfig["agent"] = {
    systemPrompt: interpolateString(systemPrompt, "agent.systemPrompt"),
    tools: [...tools] as string[],
    thinkingLevel: thinkingLevel as BenchmarkConfig["agent"]["thinkingLevel"],
    maxTurns: optionalPositiveInteger(raw.agent.maxTurns, "agent.maxTurns", 40),
    timeoutMs: optionalPositiveInteger(raw.agent.timeoutMs, "agent.timeoutMs", 30 * 60 * 1000),
  };
  if (promptTemplate !== undefined) agent.promptTemplate = interpolateString(promptTemplate, "agent.promptTemplate");
  return {
    manifestPath,
    outputDir,
    repositories,
    variants,
    agent,
    keepWorktrees: optionalBoolean(raw.keepWorktrees, "keepWorktrees", true),
  };
}

export async function loadConfig(configPath: string): Promise<BenchmarkConfig> {
  const absolutePath = resolve(configPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`failed to read config ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(parsed, absolutePath);
}

function catalogProviderId(variantName: string): string {
  return `swebench-${variantName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export function buildPiModelsCatalog(
  variants: Record<string, ModelVariantConfig>,
  selectedNames: string[],
): PiModelsCatalog {
  const providers: Record<string, JsonRecord> = {};
  const references: Record<string, PiModelReference> = {};

  for (const variantName of selectedNames) {
    const variant = variants[variantName];
    if (!variant) throw new Error(`unknown model variant: ${variantName}`);
    const provider = catalogProviderId(variantName);
    const apiKey = variant.apiKeyEnv === undefined ? (variant.apiKey ?? "dummy") : `$${variant.apiKeyEnv}`;
    providers[provider] = {
      name: variant.provider ?? `SWE-bench ${variantName}`,
      baseUrl: variant.baseUrl,
      api: variant.api ?? "openai-completions",
      apiKey,
      compat: variant.compat ?? {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
      models: [
        {
          id: variant.model,
          name: `${variantName} (${variant.model})`,
          reasoning: variant.reasoning ?? true,
          input: variant.input ?? ["text"],
          contextWindow: variant.contextWindow ?? 131072,
          maxTokens: variant.maxTokens ?? 16384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          ...(variant.samplingParams === undefined ? {} : { samplingParams: variant.samplingParams }),
        },
      ],
    };
    references[variantName] = { provider, model: variant.model };
  }

  return { providers, references };
}

export function selectVariantNames(
  variants: Record<string, ModelVariantConfig>,
  requested: string[] | undefined,
): string[] {
  if (!requested || requested.length === 0 || requested.includes("all")) return Object.keys(variants);
  const selected = new Set<string>();
  for (const name of requested) {
    if (name.endsWith("*")) {
      const prefix = name.slice(0, -1);
      for (const candidate of Object.keys(variants)) {
        if (candidate.startsWith(prefix)) selected.add(candidate);
      }
    } else {
      if (!(name in variants)) throw new Error(`unknown model variant: ${name}`);
      selected.add(name);
    }
  }
  if (selected.size === 0) throw new Error(`no model variants matched: ${requested.join(", ")}`);
  return [...selected];
}

function endpointKey(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

/** Reject a Q2/Q2+REAP run that would send both labels to one endpoint. */
export function assertDistinctComparisonEndpoints(
  variants: Record<string, ModelVariantConfig>,
  selectedNames: string[],
): void {
  if (!selectedNames.includes("q2") || !selectedNames.includes("q2-reap")) return;
  const q2 = variants.q2;
  const q2Reap = variants["q2-reap"];
  if (!q2 || !q2Reap) return;
  if (endpointKey(q2.baseUrl) === endpointKey(q2Reap.baseUrl)) {
    throw new Error(
      `q2 and q2-reap must use distinct baseUrl endpoints when selected together (both use ${q2.baseUrl})`,
    );
  }
}

export function modelRequiresEnvironment(variant: ModelVariantConfig): string | undefined {
  if (variant.apiKeyEnv !== undefined && process.env[variant.apiKeyEnv] === undefined) return variant.apiKeyEnv;
  return undefined;
}

export async function writePiModelsFile(path: string, catalog: PiModelsCatalog): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ providers: catalog.providers }, null, 2)}\n`, "utf8");
}
