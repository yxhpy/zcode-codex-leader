#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const pluginSource = path.join(repoRoot, "plugins", "zcode-codex-leader");
const zcodeManifestPath = path.join(pluginSource, ".zcode-plugin", "plugin.json");

const args = process.argv.slice(2);
const keepLocal = args.includes("--keep-local");
const deprecatedMigrateOfficial = args.includes("--migrate-official");
const unknownArgs = args.filter(
  (arg) => arg !== "--keep-local" && arg !== "--migrate-official",
);

if (unknownArgs.length > 0) {
  console.error(`Unknown option: ${unknownArgs.join(", ")}`);
  process.exit(1);
}

const manifest = await readJson(zcodeManifestPath);
const name = requiredString(manifest.name, "plugin name");
const version = requiredString(manifest.version, "plugin version");
assertSafePathSegment(name, "plugin name");
assertSafePathSegment(version, "plugin version");

const zcodePluginsRoot = path.join(os.homedir(), ".zcode", "cli", "plugins");
const officialCacheRoot = path.join(
  zcodePluginsRoot,
  "cache",
  "zcode-plugins-official",
  name,
);
const target = path.join(officialCacheRoot, version);
const officialMarketplacePath = path.join(
  zcodePluginsRoot,
  "marketplaces",
  "zcode-plugins-official",
  "marketplace.json",
);
const localCacheRoot = path.join(zcodePluginsRoot, "cache", "local", name);
const localMarketplacePath = path.join(
  zcodePluginsRoot,
  "marketplaces",
  "local",
  "marketplace.json",
);
const zcodeConfigPath = path.join(os.homedir(), ".zcode", "cli", "config.json");

const warnings = [];

if (deprecatedMigrateOfficial) {
  warnings.push(
    "--migrate-official is deprecated; zcode-plugins-official is now the managed install target.",
  );
}

await safeRm(target, officialCacheRoot, "existing official target cache");
await mkdir(path.dirname(target), { recursive: true });
await cp(pluginSource, target, { recursive: true, force: true });
await safeRm(path.join(target, ".codex-plugin"), target, "target .codex-plugin");
await cleanOldOfficialVersions();
await updateOfficialMarketplace();
await updateEnabledConfig();
if (!keepLocal) {
  await cleanupLocalLegacyInstall();
} else {
  warnings.push("Kept legacy local ZCode install because --keep-local was provided.");
}
await verifyInstall();

console.log(`Installed ${name}@${version}`);
console.log(`Cache: ${target}`);
console.log(`Marketplace: ${officialMarketplacePath}`);
console.log(`Enabled: ${name}@zcode-plugins-official`);
if (!keepLocal) {
  console.log("Removed legacy local install for this plugin, if present.");
}
for (const warning of warnings) {
  console.warn(`Warning: ${warning}`);
}
console.log("Restart ZCode, or start a new session, so the hooks take effect.");

async function readJson(filePath) {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${label} in ${zcodeManifestPath}`);
  }
  return value;
}

function assertSafePathSegment(value, label) {
  if (!/^[A-Za-z0-9._+-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

function assertInside(candidatePath, allowedRoot, label) {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(allowedRoot);
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside allowed delete root: ${candidate}`);
  }
}

function assertExact(candidatePath, allowedPath, label) {
  const candidate = path.resolve(candidatePath);
  const allowed = path.resolve(allowedPath);
  if (candidate !== allowed) {
    throw new Error(`${label} is not the expected path: ${candidate}`);
  }
}

async function safeRm(candidatePath, allowedRoot, label) {
  assertInside(candidatePath, allowedRoot, label);
  await rm(candidatePath, { recursive: true, force: true });
}

async function cleanOldOfficialVersions() {
  const entries = await readdir(officialCacheRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === version) {
      continue;
    }
    const oldPath = path.join(officialCacheRoot, entry.name);
    await safeRm(
      oldPath,
      officialCacheRoot,
      `old official cache entry ${entry.name}`,
    );
  }
}

async function updateOfficialMarketplace() {
  const marketplace =
    (await readJsonIfExists(officialMarketplacePath)) ?? {
      name: "zcode-plugins-official",
      plugins: [],
      version: 1,
    };

  if (!Array.isArray(marketplace.plugins)) {
    throw new Error(`Invalid marketplace plugins array: ${officialMarketplacePath}`);
  }

  marketplace.plugins = marketplace.plugins.filter(
    (plugin) => !(plugin && plugin.name === name),
  );
  marketplace.plugins.push({
    cachePath: target,
    name,
    source: "filesystem",
    version,
  });

  await mkdir(path.dirname(officialMarketplacePath), { recursive: true });
  await writeJson(officialMarketplacePath, marketplace);
}

async function updateEnabledConfig() {
  const config =
    (await readJsonIfExists(zcodeConfigPath)) ?? {
      plugins: {
        enabledPlugins: {},
      },
    };

  if (
    !config.plugins ||
    typeof config.plugins !== "object" ||
    Array.isArray(config.plugins)
  ) {
    config.plugins = {};
  }
  if (
    !config.plugins.enabledPlugins ||
    typeof config.plugins.enabledPlugins !== "object" ||
    Array.isArray(config.plugins.enabledPlugins)
  ) {
    config.plugins.enabledPlugins = {};
  }

  config.plugins.enabledPlugins[`${name}@zcode-plugins-official`] = true;
  delete config.plugins.enabledPlugins[`${name}@local`];

  await mkdir(path.dirname(zcodeConfigPath), { recursive: true });
  await writeJson(zcodeConfigPath, config);
}

async function cleanupLocalLegacyInstall() {
  await removeLocalMarketplaceEntry();
  await removeLocalCacheDir();
}

async function removeLocalMarketplaceEntry() {
  const marketplace = await readJsonIfExists(localMarketplacePath);
  if (!marketplace) {
    return;
  }
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error(`Invalid marketplace plugins array: ${localMarketplacePath}`);
  }

  const plugins = marketplace.plugins.filter(
    (plugin) => !(plugin && plugin.name === name),
  );
  if (plugins.length === marketplace.plugins.length) {
    return;
  }

  assertExact(
    localMarketplacePath,
    path.join(zcodePluginsRoot, "marketplaces", "local", "marketplace.json"),
    "local marketplace",
  );
  marketplace.plugins = plugins;
  await writeJson(localMarketplacePath, marketplace);
}

async function removeLocalCacheDir() {
  if (!(await pathExists(localCacheRoot))) {
    return;
  }

  assertExact(
    path.dirname(localCacheRoot),
    path.join(zcodePluginsRoot, "cache", "local"),
    "local cache parent",
  );
  assertExact(path.basename(localCacheRoot), name, "local cache plugin dir");
  await rm(localCacheRoot, { recursive: true, force: true });
}

async function verifyInstall() {
  const installedManifest = await readJson(
    path.join(target, ".zcode-plugin", "plugin.json"),
  );
  if (installedManifest.version !== version) {
    throw new Error(
      `Installed version mismatch: expected ${version}, got ${installedManifest.version}`,
    );
  }
  if (Object.hasOwn(installedManifest, "hooks")) {
    throw new Error("Installed ZCode manifest must not declare hooks; ZCode auto-discovers hooks/hooks.json and rejects duplicate declarations");
  }
  if (!(await pathExists(path.join(target, "hooks", "hooks.json")))) {
    throw new Error("Installed cache is missing hooks/hooks.json");
  }
  if (!(await pathExists(path.join(target, "hooks", "run-hook")))) {
    throw new Error("Installed cache is missing hooks/run-hook");
  }
  if (await pathExists(path.join(target, ".codex-plugin"))) {
    throw new Error("Installed cache still contains .codex-plugin");
  }

  const marketplace = await readJson(officialMarketplacePath);
  const entry =
    Array.isArray(marketplace.plugins) &&
    marketplace.plugins.find((plugin) => plugin && plugin.name === name);
  if (
    !entry ||
    entry.cachePath !== target ||
    entry.name !== name ||
    entry.source !== "filesystem" ||
    entry.version !== version
  ) {
    throw new Error("Official marketplace entry does not match installed target");
  }

  const config = await readJson(zcodeConfigPath);
  const enabledPlugins =
    config &&
    config.plugins &&
    config.plugins.enabledPlugins &&
    typeof config.plugins.enabledPlugins === "object" &&
    !Array.isArray(config.plugins.enabledPlugins)
      ? config.plugins.enabledPlugins
      : {};
  if (enabledPlugins[`${name}@zcode-plugins-official`] !== true) {
    throw new Error("Official plugin id is not enabled in ZCode config");
  }
  if (Object.hasOwn(enabledPlugins, `${name}@local`)) {
    throw new Error("Legacy local plugin id is still present in ZCode config");
  }
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}
