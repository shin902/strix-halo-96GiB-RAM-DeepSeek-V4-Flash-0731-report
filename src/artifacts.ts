import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function jsonReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };
}

export function jsonString(value: unknown): string {
  return JSON.stringify(value, jsonReplacer()) ?? "null";
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${jsonString(value)}\n`, "utf8");
}

export async function writeJsonl(path: string, values: Iterable<unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const text = [...values].map((value) => jsonString(value)).join("\n");
  await writeFile(path, text.length === 0 ? "" : `${text}\n`, "utf8");
}

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  assistantMessages: number;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function summarizeUsage(messages: readonly unknown[]): UsageSummary {
  const summary: UsageSummary = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    assistantMessages: 0,
  };
  for (const message of messages) {
    if (typeof message !== "object" || message === null || !("role" in message)) continue;
    const candidate = message as { role?: unknown; usage?: unknown };
    if (candidate.role !== "assistant" || typeof candidate.usage !== "object" || candidate.usage === null) continue;
    const usage = candidate.usage as Record<string, unknown>;
    summary.assistantMessages += 1;
    summary.input += finiteNumber(usage.input);
    summary.output += finiteNumber(usage.output);
    summary.cacheRead += finiteNumber(usage.cacheRead);
    summary.cacheWrite += finiteNumber(usage.cacheWrite);
    summary.totalTokens += finiteNumber(usage.totalTokens);
    const cost = usage.cost;
    if (typeof cost === "object" && cost !== null && "total" in cost) {
      summary.cost += finiteNumber((cost as Record<string, unknown>).total);
    }
  }
  if (summary.totalTokens === 0) {
    summary.totalTokens = summary.input + summary.output + summary.cacheRead + summary.cacheWrite;
  }
  return summary;
}

export async function writeTrajectory(path: string, messages: readonly unknown[]): Promise<void> {
  await writeJsonl(
    path,
    messages.map((message, index) => ({ index, message })),
  );
}
