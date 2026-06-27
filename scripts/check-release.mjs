#!/usr/bin/env node
import { access, readFile, readdir } from "fs/promises";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const errors = [];

const codexManifestPath = path.join(
  repoRoot,
  "plugins",
  "zcode-codex-leader",
  ".codex-plugin",
  "plugin.json",
);
const zcodeManifestPath = path.join(
  repoRoot,
  "plugins",
  "zcode-codex-leader",
  ".zcode-plugin",
  "plugin.json",
);
const claudeManifestPath = path.join(
  repoRoot,
  "plugins",
  "zcode-codex-leader",
  ".claude-plugin",
  "plugin.json",
);

const codexManifest = await readJson(codexManifestPath);
const zcodeManifest = await readJson(zcodeManifestPath);
const claudeManifest = await readJson(claudeManifestPath);

if (codexManifest.version !== zcodeManifest.version) {
  errors.push(
    `.codex-plugin version ${codexManifest.version} does not match .zcode-plugin version ${zcodeManifest.version}`,
  );
}

if (codexManifest.version !== claudeManifest.version) {
  errors.push(
    `.codex-plugin version ${codexManifest.version} does not match .claude-plugin version ${claudeManifest.version}`,
  );
}

if (codexManifest.name !== zcodeManifest.name) {
  errors.push(
    `.codex-plugin name ${codexManifest.name} does not match .zcode-plugin name ${zcodeManifest.name}`,
  );
}

if (codexManifest.name !== claudeManifest.name) {
  errors.push(
    `.codex-plugin name ${codexManifest.name} does not match .claude-plugin name ${claudeManifest.name}`,
  );
}

if (codexManifest.hooks !== "./hooks/hooks.json") {
  errors.push(".codex-plugin manifest must declare hooks: ./hooks/hooks.json");
}

if (Object.hasOwn(zcodeManifest, "hooks")) {
  errors.push(".zcode-plugin manifest must not declare hooks; ZCode auto-discovers hooks/hooks.json and treats an explicit duplicate as plugin_hook_invalid");
}

if (Object.hasOwn(claudeManifest, "hooks")) {
  errors.push(".claude-plugin manifest must not declare hooks; Claude Code auto-discovers hooks/hooks.json and treats an explicit duplicate as an error");
}

if (claudeManifest.skills !== "./skills/") {
  errors.push(".claude-plugin manifest must declare skills: ./skills/");
}

await expectPathExists(
  path.join(repoRoot, "plugins", "zcode-codex-leader", "hooks", "hooks.json"),
  "hooks/hooks.json does not exist",
);
await expectPathExists(
  path.join(repoRoot, "plugins", "zcode-codex-leader", "hooks", "run-hook"),
  "hooks/run-hook does not exist",
);

const hookScript = path.join(repoRoot, "plugins", "zcode-codex-leader", "scripts", "leader_hook.ts");
const pluginRoot = path.join(repoRoot, "plugins", "zcode-codex-leader");
const hookEnv = {
  ...process.env,
  CLAUDE_PLUGIN_ROOT: pluginRoot,
};

const hookSmoke = spawnSync(
  process.execPath,
  ["--experimental-strip-types", hookScript, "session-start"],
  {
    input: "{}",
    encoding: "utf8",
    env: hookEnv,
  },
);
if (hookSmoke.status !== 0) {
  errors.push(`leader_hook.ts session-start smoke test failed: ${hookSmoke.stderr || hookSmoke.stdout}`);
} else {
  try {
    const payload = JSON.parse(hookSmoke.stdout.trim());
    if (payload?.hookSpecificOutput?.hookEventName !== "SessionStart") {
      errors.push("leader_hook.ts session-start smoke test returned invalid hookEventName");
    }
  } catch {
    errors.push("leader_hook.ts session-start smoke test did not return JSON");
  }
}

const promptSmoke = spawnSync(
  process.execPath,
  ["--experimental-strip-types", hookScript, "user-prompt-submit"],
  {
    input: JSON.stringify({ prompt: "implement this" }),
    encoding: "utf8",
    env: hookEnv,
  },
);
if (promptSmoke.status !== 0) {
  errors.push(`leader_hook.ts user-prompt-submit smoke test failed: ${promptSmoke.stderr || promptSmoke.stdout}`);
} else {
  try {
    const payload = JSON.parse(promptSmoke.stdout.trim());
    const output = payload?.hookSpecificOutput;
    if (output?.hookEventName !== "UserPromptSubmit") {
      errors.push("leader_hook.ts user-prompt-submit smoke test returned invalid hookEventName");
    }
    if (typeof output?.additionalContext !== "string" || !output.additionalContext.includes("[Leader reminder]")) {
      errors.push("leader_hook.ts user-prompt-submit must inject the leader reminder via additionalContext");
    }
    if (Object.hasOwn(output ?? {}, "revisedPrompt")) {
      errors.push("leader_hook.ts user-prompt-submit must not emit revisedPrompt; Codex rejects that field");
    }
  } catch {
    errors.push("leader_hook.ts user-prompt-submit smoke test did not return JSON");
  }
}

const gptProBackgroundTest = spawnSync(
  process.execPath,
  ["--experimental-strip-types", path.join(repoRoot, "plugins", "zcode-codex-leader", "scripts", "gpt_pro_background_test.ts")],
  {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  },
);
if (gptProBackgroundTest.status !== 0) {
  errors.push(`gpt_pro_background_test.ts failed: ${gptProBackgroundTest.stderr || gptProBackgroundTest.stdout}`);
}

const gptProRealE2ETest = spawnSync(
  process.execPath,
  ["--experimental-strip-types", path.join(repoRoot, "plugins", "zcode-codex-leader", "scripts", "gpt_pro_real_e2e_test.ts")],
  {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  },
);
if (gptProRealE2ETest.status !== 0) {
  errors.push(`gpt_pro_real_e2e_test.ts failed: ${gptProRealE2ETest.stderr || gptProRealE2ETest.stdout}`);
}

const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
for (const forbidden of [
  "cache/zcode-plugins-official/zcode-codex-leader/0.4.0",
  "Register it in the official marketplace manifest",
]) {
  if (readme.includes(forbidden)) {
    errors.push(`README still contains forbidden text: ${forbidden}`);
  }
}

const catalog = await readJson(path.join(repoRoot, "catalog.json"));
if (!Array.isArray(catalog.plugins)) {
  errors.push("catalog.json plugins must be an array");
} else {
  for (const plugin of catalog.plugins) {
    if (!plugin || typeof plugin.path !== "string") {
      errors.push("catalog.json plugin entry is missing path");
      continue;
    }
    await expectPathExists(
      path.resolve(repoRoot, plugin.path),
      `catalog.json plugin path does not exist: ${plugin.path}`,
    );
  }
}

const agentMarketplace = await readJson(
  path.join(repoRoot, ".agents", "plugins", "marketplace.json"),
);
if (!Array.isArray(agentMarketplace.plugins)) {
  errors.push(".agents/plugins/marketplace.json plugins must be an array");
} else {
  for (const plugin of agentMarketplace.plugins) {
    const sourcePath = plugin && plugin.source && plugin.source.path;
    if (typeof sourcePath !== "string") {
      errors.push(".agents/plugins/marketplace.json plugin entry is missing source.path");
      continue;
    }
    await expectPathExists(
      path.resolve(repoRoot, sourcePath),
      `.agents/plugins/marketplace.json source.path does not exist: ${sourcePath}`,
    );
  }
}

await validateSkills(path.join(repoRoot, "plugins", "zcode-codex-leader", "skills"));

if (errors.length > 0) {
  console.error("Release check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `OK: release metadata checks passed for ${zcodeManifest.name}@${zcodeManifest.version}.`,
);

async function validateSkills(skillsRoot) {
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      errors.push(`skills directory does not exist: ${skillsRoot}`);
      return;
    }
    throw error;
  }

  const skillDirs = entries.filter((entry) => entry.isDirectory());
  if (skillDirs.length === 0) {
    errors.push(`skills directory has no skill subdirectories: ${skillsRoot}`);
    return;
  }

  for (const entry of skillDirs) {
    const skillRoot = path.join(skillsRoot, entry.name);
    const skillMdPath = path.join(skillRoot, "SKILL.md");
    let skillText;
    try {
      skillText = await readFile(skillMdPath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        errors.push(`${entry.name}: missing SKILL.md`);
        continue;
      }
      throw error;
    }

    const lines = skillText.split(/\r?\n/);
    let skillName = entry.name;
    if (lines[0] !== "---") {
      errors.push(`${entry.name}: SKILL.md missing YAML frontmatter`);
    } else {
      const end = lines.indexOf("---", 1);
      if (end === -1) {
        errors.push(`${entry.name}: SKILL.md frontmatter is not closed`);
      } else {
        const frontmatter = lines.slice(1, end).join("\n");
        const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
        const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
        if (!name) {
          errors.push(`${entry.name}: SKILL.md frontmatter missing name`);
        } else {
          skillName = name;
          if (name !== entry.name) {
            errors.push(`${entry.name}: SKILL.md name must match directory name`);
          }
        }
        if (!description) {
          errors.push(`${entry.name}: SKILL.md frontmatter missing description`);
        }
      }
    }

    if (lines.length > 500) {
      errors.push(`${entry.name}: SKILL.md should stay under 500 lines for progressive disclosure`);
    }

    const evalsPath = path.join(skillRoot, "evals", "evals.json");
    let evalsJson;
    try {
      evalsJson = await readJson(evalsPath);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        errors.push(`${entry.name}: missing evals/evals.json`);
        continue;
      }
      errors.push(`${entry.name}: invalid evals/evals.json (${error.message})`);
      continue;
    }

    if (evalsJson.skill_name !== skillName) {
      errors.push(`${entry.name}: evals/evals.json skill_name must match SKILL.md name`);
    }
    if (!Array.isArray(evalsJson.evals) || evalsJson.evals.length === 0) {
      errors.push(`${entry.name}: evals/evals.json must contain at least one eval`);
      continue;
    }

    const ids = new Set();
    for (const [index, evalCase] of evalsJson.evals.entries()) {
      const label = `${entry.name}: evals[${index}]`;
      if (!Number.isInteger(evalCase.id)) {
        errors.push(`${label} id must be an integer`);
      } else if (ids.has(evalCase.id)) {
        errors.push(`${label} id must be unique`);
      } else {
        ids.add(evalCase.id);
      }
      if (typeof evalCase.prompt !== "string" || evalCase.prompt.trim() === "") {
        errors.push(`${label} prompt must be a non-empty string`);
      }
      if (typeof evalCase.expected_output !== "string" || evalCase.expected_output.trim() === "") {
        errors.push(`${label} expected_output must be a non-empty string`);
      }
      if (evalCase.files !== undefined && !Array.isArray(evalCase.files)) {
        errors.push(`${label} files must be an array when present`);
      }
      if (Array.isArray(evalCase.files)) {
        for (const file of evalCase.files) {
          if (typeof file !== "string" || file.trim() === "") {
            errors.push(`${label} files entries must be non-empty strings`);
            continue;
          }
          await expectPathExists(path.join(skillRoot, file), `${label} file does not exist: ${file}`);
        }
      }
      if (!Array.isArray(evalCase.expectations) || evalCase.expectations.length === 0) {
        errors.push(`${label} expectations must contain at least one item`);
      } else if (!evalCase.expectations.every((item) => typeof item === "string" && item.trim() !== "")) {
        errors.push(`${label} expectations entries must be non-empty strings`);
      }
    }
  }
}

async function readJson(filePath) {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function expectPathExists(filePath, message) {
  try {
    await access(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      errors.push(message);
      return;
    }
    throw error;
  }
}
