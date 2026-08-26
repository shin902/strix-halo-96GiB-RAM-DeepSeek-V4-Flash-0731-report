import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseConfig, selectVariantNames } from "../src/config.js";
import { loadManifest } from "../src/manifest.js";
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

test("patch capture failure marks an otherwise completed run as error", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-patch-capture-test-"));
  const fixture = await createGitFixture(root);
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
  const createSession = (async (options: { cwd: string }) => {
    const session = {
      messages: [],
      subscribe: () => () => undefined,
      prompt: async () => {
        await rm(join(options.cwd, ".git", "HEAD"));
      },
      abort: async () => undefined,
      dispose: () => undefined,
    };
    return { session };
  }) as unknown as AgentSessionFactory;

  const summary = await runBenchmark(config, {
    mode: "run",
    variantNames: ["q2-reap"],
    createSession,
  });

  const result = summary.results[0];
  assert.equal(result?.status, "error");
  assert.match(result?.error ?? "", /git diff .*failed/);
  const artifactRoot = join(root, "runs", "q2-reap", "repo__project-1");
  const timing = JSON.parse(await readFile(join(artifactRoot, "timing.json"), "utf8")) as { status: string };
  assert.equal(timing.status, "error");
  assert.equal(await readFile(join(artifactRoot, "patch.diff"), "utf8"), "");
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

test("formal Web benchmark has the pinned 30-instance selection and matching lock", async () => {
  const config = await loadConfig("configs/swebench-multilingual-web-30.json");
  const instances = await loadManifest(config.manifestPath);
  const lock = JSON.parse(await readFile("configs/swebench-multilingual-web-30.lock.json", "utf8")) as {
    dataset: string;
    config: string;
    split: string;
    revision: string;
    source: { path: string; url: string; sha256: string };
    totalRows: number;
    selection: { count: number; repositories: string[]; repoCounts: Record<string, number> };
    manifest: { path: string; count: number; sha256: string; fields: string[]; excludedFields: string[] };
    instanceIds: string[];
  };
  const expectedRepositories = ["preactjs/preact", "vuejs/core", "facebook/docusaurus", "mrdoob/three.js"];
  const expectedCounts = {
    "preactjs/preact": 17,
    "vuejs/core": 5,
    "facebook/docusaurus": 5,
    "mrdoob/three.js": 3,
  };
  const counts = Object.fromEntries(expectedRepositories.map((repo) => [
    repo,
    instances.filter((instance) => instance.repo === repo).length,
  ]));
  const manifestBytes = await readFile(config.manifestPath);

  assert.deepEqual(Object.keys(config.repositories), expectedRepositories);
  assert.notEqual(config.variants.q2?.baseUrl, config.variants["q2-reap"]?.baseUrl);
  assert.equal(instances.length, 30);
  assert.equal(new Set(instances.map((instance) => instance.instance_id)).size, 30);
  assert.deepEqual(counts, expectedCounts);
  assert.deepEqual(lock.selection.repositories, expectedRepositories);
  assert.deepEqual(lock.selection.repoCounts, expectedCounts);
  assert.equal(lock.selection.count, 30);
  assert.equal(lock.totalRows, 300);
  assert.equal(lock.dataset, "SWE-bench/SWE-bench_Multilingual");
  assert.equal(lock.config, "default");
  assert.equal(lock.split, "test");
  assert.equal(lock.revision, "846e647b9f33c0b51b739d005d13d85493c9af09");
  assert.equal(lock.source.path, "data/test-00000-of-00001.parquet");
  assert.equal(lock.source.url, "https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual/resolve/846e647b9f33c0b51b739d005d13d85493c9af09/data/test-00000-of-00001.parquet");
  assert.equal(lock.source.sha256, "92abca7cb527b41a9f66d03a26ce441ff7319e3a49f985998fd56be4bb9b08b2");
  assert.equal(lock.manifest.path, "swebench-multilingual-web-30.jsonl");
  assert.equal(lock.manifest.count, 30);
  assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), lock.manifest.sha256);
  assert.deepEqual(lock.instanceIds, instances.map((instance) => instance.instance_id));
  assert.deepEqual(lock.manifest.fields, ["repo", "instance_id", "base_commit", "problem_statement"]);
  assert.deepEqual(lock.manifest.excludedFields, ["patch", "test_patch", "eval_script"]);
  for (const instance of instances) {
    assert.deepEqual(Object.keys(instance).sort(), ["base_commit", "instance_id", "problem_statement", "repo"]);
  }
});

test("rejects a same-endpoint q2 and q2-reap comparison", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-endpoint-validation-test-"));
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
  config.variants["q2-reap"]!.baseUrl = config.variants.q2!.baseUrl;

  await assert.rejects(
    runBenchmark(config, { mode: "dry-run", variantNames: ["q2", "q2-reap"], limit: 1 }),
    /q2 and q2-reap must use distinct baseUrl endpoints/,
  );
});

test("Verified 20 and SymPy smoke benchmark files remain available", async () => {
  for (const path of [
    "configs/swebench-verified-20.json",
    "configs/swebench-verified-20.jsonl",
    "configs/swebench-verified-20.lock.json",
    "configs/swebench-verified-single-sympy-12481.json",
    "configs/swebench-verified-single-sympy-12481.jsonl",
  ]) {
    await assert.doesNotReject(access(resolve(path)));
  }
  assert.equal((await loadManifest(resolve("configs/swebench-verified-20.jsonl"))).length, 20);
  assert.equal((await loadManifest(resolve("configs/swebench-verified-single-sympy-12481.jsonl"))).length, 1);
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
