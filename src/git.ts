import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, isAbsolute, resolve } from "node:path";
import type { BenchmarkConfig, BenchmarkInstance } from "./types.js";

const execFileAsync = promisify(execFile);

export async function runGit(args: string[], cwd?: string): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed${cwd ? ` in ${cwd}` : ""}: ${detail}`);
  }
}

function repositorySource(config: BenchmarkConfig, instance: BenchmarkInstance): string {
  if (instance.repo_dir !== undefined) {
    return isAbsolute(instance.repo_dir)
      ? instance.repo_dir
      : resolve(dirname(config.manifestPath), instance.repo_dir);
  }
  if (instance.repo !== undefined) {
    const source = config.repositories[instance.repo];
    if (source !== undefined) return source;
    throw new Error(`no repository mapping for ${instance.repo} (${instance.instance_id})`);
  }
  throw new Error(`instance ${instance.instance_id} has neither repo_dir nor repo`);
}

export async function prepareWorkspace(
  config: BenchmarkConfig,
  instance: BenchmarkInstance,
  workspaceDir: string,
): Promise<void> {
  const source = repositorySource(config, instance);
  await mkdir(workspaceDir, { recursive: false });
  await runGit(["clone", "--no-hardlinks", source, workspaceDir]);
  if (instance.base_commit !== undefined && instance.base_commit.length > 0) {
    await runGit(["checkout", "--detach", instance.base_commit], workspaceDir);
  } else {
    await runGit(["checkout", "--detach", "HEAD"], workspaceDir);
  }
}

function summarizeStatus(status: string): string {
  const entries = status.trim().split(/\r?\n/).filter((line) => line.length > 0);
  const preview = entries.slice(0, 5).join("; ");
  return `${entries.length} change${entries.length === 1 ? "" : "s"}${preview.length > 0 ? ` (${preview}${entries.length > 5 ? "; …" : ""})` : ""}`;
}

/**
 * Verify the disposable checkout before giving it to the agent.
 *
 * A local clone made from a partial source can report a successful checkout
 * while leaving a dirty worktree or an unreadable HEAD. Those conditions must
 * be rejected before Pi creates a session or sends a prompt.
 */
export async function validateWorkspace(workspaceDir: string, expectedCommit?: string): Promise<void> {
  const worktree = (await runGit(["rev-parse", "--is-inside-work-tree"], workspaceDir)).trim();
  if (worktree !== "true") {
    throw new Error(`workspace validation failed in ${workspaceDir}: not a Git worktree`);
  }

  const head = (await runGit(["rev-parse", "--verify", "HEAD^{commit}"], workspaceDir)).trim();
  await runGit(["rev-parse", "--verify", "HEAD^{tree}"], workspaceDir);
  if (expectedCommit !== undefined && expectedCommit.trim().length > 0) {
    const expected = (await runGit(["rev-parse", "--verify", `${expectedCommit}^{commit}`], workspaceDir)).trim();
    if (head !== expected) {
      throw new Error(`workspace validation failed in ${workspaceDir}: expected base commit ${expected}, got ${head}`);
    }
  }

  const status = await gitStatus(workspaceDir);
  if (status.trim().length > 0) {
    throw new Error(`workspace validation failed in ${workspaceDir}: worktree is not clean (${summarizeStatus(status)})`);
  }

  // A clean status alone does not prove that Git can read the checkout's
  // objects. Force the same binary diff path used for the final artifact.
  await runGit(["diff", "--quiet", "HEAD", "--binary", "--no-ext-diff", "--"], workspaceDir);
}

export async function gitDiff(workspaceDir: string): Promise<string> {
  // Include newly-created files and changes an agent may have staged. The clone
  // is disposable, so intent-to-add does not affect the source checkout.
  try {
    await runGit(["add", "-N", "--", "."], workspaceDir);
  } catch {
    // A malformed/conflicted worktree should still produce the ordinary diff.
  }
  return runGit(["diff", "HEAD", "--binary", "--no-ext-diff"], workspaceDir);
}

export async function gitStatus(workspaceDir: string): Promise<string> {
  return runGit(["status", "--short"], workspaceDir);
}
