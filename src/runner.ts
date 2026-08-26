import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { writeJson, writeJsonl, writeTrajectory, summarizeUsage } from "./artifacts.js";
import {
  buildPiModelsCatalog,
  modelRequiresEnvironment,
  writePiModelsFile,
  type PiModelsCatalog,
} from "./config.js";
import { gitDiff, gitStatus, prepareWorkspace, validateWorkspace } from "./git.js";
import { loadManifest, selectInstances } from "./manifest.js";
import { createBenchmarkResourceLoader } from "./resource-loader.js";
import type {
  BenchmarkConfig,
  BenchmarkInstance,
  ModelVariantConfig,
  RunMode,
  RunResult,
  RunSummary,
} from "./types.js";

const DEFAULT_PROMPT = `You are solving a SWE-bench issue in the repository checked out in the current working directory.

Instance: {{instance_id}}
Repository: {{repo}}

Problem statement:
{{problem_statement}}

Inspect the repository, implement the smallest correct fix, and run relevant tests when practical. Work directly in the current working directory. Do not merely describe a patch: leave the working tree containing the proposed code changes. Do not modify files outside the current working directory.`;

export type AgentSessionFactory = typeof createAgentSession;

export interface BenchmarkRunOptions {
  mode: RunMode;
  variantNames: string[];
  instanceIds?: string[];
  limit?: number;
  /** Test seam; the real Pi factory remains the default. */
  createSession?: AgentSessionFactory;
}

interface RunContext {
  config: BenchmarkConfig;
  variantName: string;
  variant: ModelVariantConfig;
  catalog: PiModelsCatalog;
  modelRuntime?: ModelRuntime;
  createSession: AgentSessionFactory;
}

function artifactName(instanceId: string): string {
  const safe = instanceId.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe === "." || safe === ".." || safe.length === 0 ? `_${safe || "instance"}` : safe;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function abortSession(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): Promise<void> {
  await Promise.race([session.abort().catch(() => undefined), wait(5000)]);
}

function substitutePrompt(template: string, instance: BenchmarkInstance): string {
  const values: Record<string, string> = {
    instance_id: instance.instance_id,
    repo: instance.repo ?? instance.repo_dir ?? "unknown",
    problem_statement: instance.problem_statement,
  };
  return template.replace(/\{\{(instance_id|repo|problem_statement)\}\}/g, (_match, key: string) => values[key] ?? "");
}

function artifactMetadata(context: RunContext, instance: BenchmarkInstance, workspaceDir: string): Record<string, unknown> {
  return {
    variant: context.variantName,
    provider: context.variant.provider ?? null,
    model: context.variant.model,
    endpoint: context.variant.baseUrl,
    api: context.variant.api ?? "openai-completions",
    samplingParams: context.variant.samplingParams ?? null,
    compat: context.variant.compat ?? null,
    instance_id: instance.instance_id,
    repo: instance.repo ?? null,
    base_commit: instance.base_commit ?? null,
    workspace: workspaceDir,
    tools: context.config.agent.tools,
    thinkingLevel: context.config.agent.thinkingLevel,
    maxTurns: context.config.agent.maxTurns,
    timeoutMs: context.config.agent.timeoutMs,
  };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    assistantMessages: 0,
  };
}

async function writeDryRunArtifacts(
  context: RunContext,
  instance: BenchmarkInstance,
  artifactDir: string,
  workspaceDir: string,
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  await mkdir(artifactDir, { recursive: true });
  await writeJson(join(artifactDir, "run.json"), {
    ...artifactMetadata(context, instance, workspaceDir),
    mode: "dry-run",
    prompt: substitutePrompt(context.config.agent.promptTemplate ?? DEFAULT_PROMPT, instance),
  });
  await writeJsonl(join(artifactDir, "events.jsonl"), []);
  await writeJsonl(join(artifactDir, "trajectory.jsonl"), []);
  await writeJson(join(artifactDir, "usage.json"), emptyUsage());
  await writeFile(join(artifactDir, "patch.diff"), "", "utf8");
  await writeFile(join(artifactDir, "git-status.txt"), "", "utf8");
  await writeJson(join(artifactDir, "timing.json"), {
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    status: "dry-run",
    turns: 0,
  });
  return {
    variant: context.variantName,
    instanceId: instance.instance_id,
    status: "dry-run",
    patch: "",
    artifactDir,
    turns: 0,
    durationMs: Date.now() - started,
  };
}

async function runRealInstance(
  context: RunContext,
  instance: BenchmarkInstance,
  artifactDir: string,
  workspaceDir: string,
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const events: unknown[] = [];
  let turns = 0;
  let timedOut = false;
  let turnLimitReached = false;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let workspaceValidated = false;
  let patch = "";
  let status: RunResult["status"] = "completed";
  let failure: string | undefined;

  await mkdir(artifactDir, { recursive: true });
  await writeJson(join(artifactDir, "run.json"), {
    ...artifactMetadata(context, instance, workspaceDir),
    mode: "run",
    prompt: substitutePrompt(context.config.agent.promptTemplate ?? DEFAULT_PROMPT, instance),
  });

  try {
    await prepareWorkspace(context.config, instance, workspaceDir);
    await validateWorkspace(workspaceDir, instance.base_commit);
    workspaceValidated = true;

    const reference = context.catalog.references[context.variantName];
    if (!reference || !context.modelRuntime) throw new Error(`missing Pi model reference for ${context.variantName}`);
    const model = context.modelRuntime.getModel(reference.provider, reference.model);
    if (!model) throw new Error(`Pi model not found: ${reference.provider}/${reference.model}`);

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      defaultThinkingLevel: context.config.agent.thinkingLevel,
    });
    const resourceLoader = createBenchmarkResourceLoader(context.config.agent.systemPrompt);
    const sessionResult = await context.createSession({
      cwd: workspaceDir,
      agentDir: dirname(context.config.outputDir),
      model,
      modelRuntime: context.modelRuntime,
      thinkingLevel: context.config.agent.thinkingLevel,
      tools: context.config.agent.tools,
      resourceLoader,
      sessionManager: SessionManager.inMemory(workspaceDir),
      settingsManager,
    });
    session = sessionResult.session;
    const activeSession = session;

    const unsubscribe = activeSession.subscribe((event: AgentSessionEvent) => {
      events.push({
        sequence: events.length,
        timestamp: new Date().toISOString(),
        event,
      });
      if (event.type === "turn_end") {
        turns += 1;
        if (turns >= context.config.agent.maxTurns && !turnLimitReached) {
          turnLimitReached = true;
          void activeSession.abort().catch(() => undefined);
        }
      }
    });

    const prompt = substitutePrompt(context.config.agent.promptTemplate ?? DEFAULT_PROMPT, instance);
    const completion = activeSession.prompt(prompt).then(
      () => "completed" as const,
      (error: unknown) => {
        failure = errorMessage(error);
        return "error" as const;
      },
    );
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        resolve("timeout");
        void activeSession.abort().catch(() => undefined);
      }, context.config.agent.timeoutMs);
    });
    const outcome = await Promise.race([completion, timeout]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (outcome === "timeout") {
      status = "timeout";
      await Promise.race([completion, wait(5000)]);
    } else if (outcome === "error") {
      status = turnLimitReached ? "turn-limit" : "error";
    } else if (turnLimitReached) {
      status = "turn-limit";
    }

    unsubscribe();
  } catch (error) {
    failure = failure ?? errorMessage(error);
    status = timedOut ? "timeout" : turnLimitReached ? "turn-limit" : "error";
  } finally {
    if (session !== undefined) {
      try {
        await abortSession(session);
      } catch {
        // The artifact still contains the partial trajectory when abort cleanup fails.
      }
      const messages = [...session.messages];
      await writeTrajectory(join(artifactDir, "trajectory.jsonl"), messages);
      await writeJson(join(artifactDir, "usage.json"), summarizeUsage(messages));
      session.dispose();
    } else {
      await writeJsonl(join(artifactDir, "trajectory.jsonl"), []);
      await writeJson(join(artifactDir, "usage.json"), emptyUsage());
    }

    if (workspaceValidated) {
      try {
        patch = await gitDiff(workspaceDir);
      } catch (error) {
        failure = failure ?? errorMessage(error);
      }
    }
    try {
      await writeFile(join(artifactDir, "git-status.txt"), await gitStatus(workspaceDir), "utf8");
    } catch (error) {
      failure = failure ?? errorMessage(error);
      await writeFile(join(artifactDir, "git-status.txt"), "", "utf8");
    }
    await writeFile(join(artifactDir, "patch.diff"), patch, "utf8");
    await writeJsonl(join(artifactDir, "events.jsonl"), events);
    await writeJson(join(artifactDir, "timing.json"), {
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      status,
      turns,
      timedOut,
      turnLimitReached,
      error: failure ?? null,
    });
    if (!context.config.keepWorktrees) {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }

  return {
    variant: context.variantName,
    instanceId: instance.instance_id,
    status,
    patch,
    artifactDir,
    turns,
    durationMs: Date.now() - started,
    ...(failure === undefined ? {} : { error: failure }),
  };
}

async function writePredictions(outputDir: string, variantName: string, results: RunResult[]): Promise<string> {
  const path = join(outputDir, "predictions.jsonl");
  await writeJsonl(
    path,
    results.map((result) => ({
      instance_id: result.instanceId,
      model_name_or_path: result.variant,
      model_patch: result.patch,
    })),
  );
  return path;
}

export async function runBenchmark(config: BenchmarkConfig, options: BenchmarkRunOptions): Promise<RunSummary> {
  const manifest = await loadManifest(config.manifestPath);
  const instances = selectInstances(manifest, options.instanceIds, options.limit);
  const catalog = buildPiModelsCatalog(config.variants, options.variantNames);
  const results: RunResult[] = [];
  const predictions: Record<string, string> = {};
  let modelRuntime: ModelRuntime | undefined;
  let runtimeDir: string | undefined;

  if (options.mode === "run") {
    for (const variantName of options.variantNames) {
      const missing = modelRequiresEnvironment(config.variants[variantName]!);
      if (missing !== undefined) throw new Error(`missing environment variable ${missing} for variant ${variantName}`);
    }
    runtimeDir = await mkdtemp(join(tmpdir(), "swebench-pi-"));
    const modelsPath = join(runtimeDir, "models.json");
    await writePiModelsFile(modelsPath, catalog);
    modelRuntime = await ModelRuntime.create({
      authPath: join(runtimeDir, "auth.json"),
      modelsPath,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
  }

  try {
    for (const variantName of options.variantNames) {
      const variant = config.variants[variantName];
      if (!variant) throw new Error(`unknown model variant: ${variantName}`);
      const context: RunContext = {
        config,
        variantName,
        variant,
        catalog,
        createSession: options.createSession ?? createAgentSession,
        ...(modelRuntime === undefined ? {} : { modelRuntime }),
      };
      const variantResults: RunResult[] = [];
      for (const instance of instances) {
        const artifactDir = join(config.outputDir, variantName, artifactName(instance.instance_id));
        await rm(artifactDir, { recursive: true, force: true });
        const workspaceDir = join(artifactDir, "workspace");
        const result = options.mode === "dry-run"
          ? await writeDryRunArtifacts(context, instance, artifactDir, workspaceDir)
          : await runRealInstance(context, instance, artifactDir, workspaceDir);
        results.push(result);
        variantResults.push(result);
      }
      predictions[variantName] = await writePredictions(join(config.outputDir, variantName), variantName, variantResults);
    }
  } finally {
    if (runtimeDir !== undefined) await rm(runtimeDir, { recursive: true, force: true });
  }

  return {
    mode: options.mode,
    variants: options.variantNames,
    instances: instances.map((instance) => instance.instance_id),
    results,
    predictions,
  };
}
