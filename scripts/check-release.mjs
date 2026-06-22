#!/usr/bin/env node
import { access, readFile } from "fs/promises";
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

const codexManifest = await readJson(codexManifestPath);
const zcodeManifest = await readJson(zcodeManifestPath);

if (codexManifest.version !== zcodeManifest.version) {
  errors.push(
    `.codex-plugin version ${codexManifest.version} does not match .zcode-plugin version ${zcodeManifest.version}`,
  );
}

if (codexManifest.name !== zcodeManifest.name) {
  errors.push(
    `.codex-plugin name ${codexManifest.name} does not match .zcode-plugin name ${zcodeManifest.name}`,
  );
}

if (codexManifest.hooks !== "./hooks/hooks.json") {
  errors.push(".codex-plugin manifest must declare hooks: ./hooks/hooks.json");
}

if (Object.hasOwn(zcodeManifest, "hooks")) {
  errors.push(".zcode-plugin manifest must not declare hooks; ZCode auto-discovers hooks/hooks.json and treats an explicit duplicate as plugin_hook_invalid");
}

await expectPathExists(
  path.join(repoRoot, "plugins", "zcode-codex-leader", "hooks", "hooks.json"),
  "hooks/hooks.json does not exist",
);
await expectPathExists(
  path.join(repoRoot, "plugins", "zcode-codex-leader", "hooks", "run-hook"),
  "hooks/run-hook does not exist",
);

const hookSmoke = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    path.join(repoRoot, "plugins", "zcode-codex-leader", "scripts", "leader_hook.ts"),
    "session-start",
  ],
  {
    input: "{}",
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: path.join(repoRoot, "plugins", "zcode-codex-leader"),
    },
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
