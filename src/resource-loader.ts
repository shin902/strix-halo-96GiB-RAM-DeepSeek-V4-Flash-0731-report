import { createExtensionRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";

/**
 * A deliberately empty loader: benchmark runs must not inherit the caller's
 * skills, extensions, prompts, themes, or AGENTS.md files.
 */
export function createBenchmarkResourceLoader(systemPrompt: string): ResourceLoader {
  const extensions = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };

  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}
