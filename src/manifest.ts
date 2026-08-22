import { readFile } from "node:fs/promises";
import type { BenchmarkInstance } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInstance(value: unknown, source: string): BenchmarkInstance {
  if (!isRecord(value)) throw new Error(`${source} must contain JSON objects`);
  if (typeof value.instance_id !== "string" || value.instance_id.length === 0) {
    throw new Error(`${source} is missing instance_id`);
  }
  if (typeof value.problem_statement !== "string") {
    throw new Error(`${source} is missing problem_statement`);
  }
  return value as BenchmarkInstance;
}

/** Load the JSONL format used by SWE-bench, with JSON-array support for small fixtures. */
export async function loadManifest(path: string): Promise<BenchmarkInstance[]> {
  const text = await readFile(path, "utf8");
  const first = text.trimStart()[0];
  let values: unknown[];
  if (first === "[") {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`manifest ${path} is not a JSON array`);
    values = parsed;
  } else {
    values = text
      .split(/\r?\n/)
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => line.length > 0 && !line.startsWith("#"))
      .map(({ line, index }) => {
        try {
          return JSON.parse(line) as unknown;
        } catch (error) {
          throw new Error(`invalid JSON in ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
  }

  const instances = values.map((value, index) => parseInstance(value, `${path}:${index + 1}`));
  const seen = new Set<string>();
  for (const instance of instances) {
    if (seen.has(instance.instance_id)) throw new Error(`duplicate instance_id in manifest: ${instance.instance_id}`);
    seen.add(instance.instance_id);
  }
  return instances;
}

export function selectInstances(
  instances: BenchmarkInstance[],
  requestedIds: string[] | undefined,
  limit: number | undefined,
): BenchmarkInstance[] {
  const requested = requestedIds && requestedIds.length > 0 ? new Set(requestedIds) : undefined;
  const filtered = requested === undefined
    ? instances
    : instances.filter((instance) => requested.has(instance.instance_id));
  if (requested !== undefined) {
    const found = new Set(filtered.map((instance) => instance.instance_id));
    const missing = [...requested].filter((id) => !found.has(id));
    if (missing.length > 0) throw new Error(`instance_id not found in manifest: ${missing.join(", ")}`);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("limit must be a positive integer");
  }
  return limit === undefined ? filtered : filtered.slice(0, limit);
}
