#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, selectVariantNames } from "./config.js";
import { runBenchmark } from "./runner.js";
import type { RunMode } from "./types.js";

interface CliOptions {
  configPath: string;
  mode: RunMode;
  variants?: string[];
  instances?: string[];
  limit?: number;
  envFile?: string;
}

function usage(): string {
  return `Usage: npm run bench -- [options]

Options:
  --config <path>       JSON benchmark config (default: configs/example.json)
  --variant <name,...>  Variants to run; supports reap-* and all (default: all)
  --instance <id,...>   Restrict to manifest instance ids
  --limit <n>           Run only the first n manifest entries
  --mode <run|dry-run>  Execute Pi or only create/validate artifacts (default: run)
  --env-file <path>     Load KEY=VALUE entries before reading config
  --help                Show this message
`;
}

function takeValue(args: string[], index: number, flag: string): [string, number] {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return [value, index + 1];
}

function parseArgs(args: string[]): CliOptions | undefined {
  const options: CliOptions = {
    configPath: "configs/example.json",
    mode: "run",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      return undefined;
    }
    if (arg === "--config") {
      const [value, next] = takeValue(args, index, arg);
      options.configPath = value;
      index = next;
    } else if (arg === "--variant") {
      const [value, next] = takeValue(args, index, arg);
      options.variants = value.split(",").map((item) => item.trim()).filter(Boolean);
      index = next;
    } else if (arg === "--instance") {
      const [value, next] = takeValue(args, index, arg);
      options.instances = value.split(",").map((item) => item.trim()).filter(Boolean);
      index = next;
    } else if (arg === "--limit") {
      const [value, next] = takeValue(args, index, arg);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--limit must be a positive integer");
      options.limit = parsed;
      index = next;
    } else if (arg === "--mode") {
      const [value, next] = takeValue(args, index, arg);
      if (value !== "run" && value !== "dry-run") throw new Error("--mode must be run or dry-run");
      options.mode = value;
      index = next;
    } else if (arg === "--env-file") {
      const [value, next] = takeValue(args, index, arg);
      options.envFile = value;
      index = next;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

async function loadEnvFile(path: string): Promise<void> {
  const text = await readFile(path, "utf8");
  for (const [lineNumber, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`invalid .env line ${path}:${lineNumber + 1}`);
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]!] === undefined) process.env[match[1]!] = value;
  }
}

async function loadOptionalEnvFile(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  await loadEnvFile(path);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  if (options === undefined) return;
  const configPath = resolve(options.configPath);
  if (options.envFile !== undefined) {
    await loadEnvFile(resolve(options.envFile));
  } else {
    await loadOptionalEnvFile(resolve(".env"));
  }
  const config = await loadConfig(configPath);
  const variantNames = selectVariantNames(config.variants, options.variants);
  const summary = await runBenchmark(config, {
    mode: options.mode,
    variantNames,
    ...(options.instances === undefined ? {} : { instanceIds: options.instances }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
