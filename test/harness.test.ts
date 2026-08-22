import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseConfig, selectVariantNames } from "../src/config.js";
import { runGit, prepareWorkspace, validateWorkspace } from "../src/git.js";
import { type AgentSessionFactory, runBenchmark } from "../src/runner.js";
import type { ModelVariantConfig } from "../src/types.js";

function fixtureConfig(root: string, repositories: Record<string, string> = {}) {
  return parseConfig(
    {
      manifestPath: "manifest.jsonl",
      outputDir: "runs",
      repositories,
      variants: {
        "cloud-fp": { baseUrl: "https://example.invalid/v1", model: "cloud-model", apiKey: "dummy" },
        q2: { baseUrl: "http://127.0.0.1:8101/v1", model: "q2-model", apiKey: "dummy" },
        "q2-reap": { baseUrl: "http://127.0.0.1:8000/v1", model: "deepseek-v4-flash", apiKey: "dummy" },
        "reap-a": { baseUrl: "http://127.0.0.1:8102/v1", model: "reap-a", apiKey: "dummy" },
      },
      agent: {
        systemPrompt: "fixed system prompt",
        tools: ["read", "bash"],
        thinkingLevel: "off",
        maxTurns: 2,
        timeoutMs: 1000,
      },
    },
    join(root, "config.json"),
  );
}

async function createGitFixture(root: string): Promise<{ source: string; commit: string; blob: string }> {
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await runGit(["init", "--initial-branch=main", source]);
  await runGit(["config", "user.email", "test@example.invalid"], source);
  await runGit(["config", "user.name", "SWE-bench test"], source);
  await writeFile(join(source, "tracked.txt"), "fixture content\n", "utf8");
  await runGit(["add", "tracked.txt"], source);
  await runGit(["commit", "-m", "fixture"], source);
  const commit = (await runGit(["rev-parse", "HEAD"], source)).trim();
  const blob = (await runGit(["rev-parse", "HEAD:tracked.txt"], source)).trim();
  return { source, commit, blob };
}

test("preflight accepts a clean checkout and rejects a dirty checkout or wrong base object", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-git-test-"));
  const fixture = await createGitFixture(root);
  const config = fixtureConfig(root, { repo: fixture.source });
  const instance = {
    instance_id: "repo__project-1",
    repo: "repo",
    base_commit: fixture.commit,
    problem_statement: "Fix the example.",
  };
  const workspace = join(root, "workspace");

  await prepareWorkspace(config, instance, workspace);
  await assert.doesNotReject(validateWorkspace(workspace, fixture.commit));

  await rm(join(workspace, "tracked.txt"));
  await assert.rejects(validateWorkspace(workspace, fixture.commit), /worktree is not clean/);
  await assert.rejects(validateWorkspace(workspace, "0".repeat(40)), /git .*rev-parse .*failed/);
});

test("corrupt repository fails before an agent session is created", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-corrupt-repo-test-"));
  const fixture = await createGitFixture(root);
  await rm(join(fixture.source, ".git", "objects", fixture.blob.slice(0, 2), fixture.blob.slice(2)));
  await assert.rejects(runGit(["cat-file", "-e", fixture.blob], fixture.source));
  await writeFile(
    join(root, "manifest.jsonl"),
    `${JSON.stringify({
      instance_id: "repo__project-1",
      repo: "repo",
      base_commit: fixture.commit,
      problem_statement: "Fix the example.",
    })}\n`,
    "utf8",
  );
  const config = fixtureConfig(root, { repo: fixture.source });
  let sessionStarts = 0;
  const createSession = (async () => {
    sessionStarts += 1;
    throw new Error("unexpected agent session");
  }) as AgentSessionFactory;

  const summary = await runBenchmark(config, {
    mode: "run",
    variantNames: ["q2-reap"],
    createSession,
  });

  const result = summary.results[0];
  assert.equal(result?.status, "error");
  assert.equal(result?.turns, 0);
  assert.match(result?.error ?? "", /git clone|unable to read|checkout/);
  assert.equal(sessionStarts, 0);
  const artifactRoot = join(root, "runs", "q2-reap", "repo__project-1");
  assert.equal(await readFile(join(artifactRoot, "trajectory.jsonl"), "utf8"), "");
  assert.equal(await readFile(join(artifactRoot, "events.jsonl"), "utf8"), "");
});

test("fixed q2+REAP config keeps the variant name and repository keys aligned", async () => {
  const config = await loadConfig("configs/swebench-verified-20.json");
  assert.ok(config.variants["q2-reap"]);
  assert.deepEqual(Object.keys(config.repositories).sort(), [
    "django/django",
    "matplotlib/matplotlib",
    "pytest-dev/pytest",
    "scikit-learn/scikit-learn",
    "sphinx-doc/sphinx",
    "sympy/sympy",
  ]);
});

test("selects exact variants and reap wildcard", () => {
  const names: Record<string, ModelVariantConfig> = {
    "cloud-fp": { model: "cloud", baseUrl: "https://example.invalid" },
    q2: { model: "q2", baseUrl: "http://127.0.0.1" },
    "reap-a": { model: "reap-a", baseUrl: "http://127.0.0.1" },
    "reap-b": { model: "reap-b", baseUrl: "http://127.0.0.1" },
  };
  assert.deepEqual(selectVariantNames(names, ["cloud-fp", "reap-*"]), ["cloud-fp", "reap-a", "reap-b"]);
});

test("dry-run creates per-variant artifacts and grader predictions", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-harness-test-"));
  await writeFile(
    join(root, "manifest.jsonl"),
    `${JSON.stringify({
      instance_id: "repo__project-1",
      repo: "repo",
      base_commit: "abc",
      problem_statement: "Fix the example.",
    })}\n`,
    "utf8",
  );
  const config = fixtureConfig(root);
  const summary = await runBenchmark(config, {
    mode: "dry-run",
    variantNames: ["cloud-fp", "q2"],
    limit: 1,
  });

  assert.equal(summary.results.length, 2);
  assert.equal(summary.results[0]?.status, "dry-run");
  for (const variant of ["cloud-fp", "q2"]) {
    const artifactRoot = join(root, "runs", variant, "repo__project-1");
    assert.equal(await readFile(join(artifactRoot, "timing.json"), "utf8").then((text) => JSON.parse(text).status), "dry-run");
    const prediction = await readFile(join(root, "runs", variant, "predictions.jsonl"), "utf8");
    assert.match(prediction, /"instance_id":"repo__project-1"/);
    assert.match(prediction, /"model_patch":""/);
  }
});
