import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_FILES = [
  "plugin.conf", "install.sh", "update.sh", "uninstall.sh", "health.sh",
  "runtime.mjs", "directadmin-relay.mjs", "file-bridge.mjs", "package.json", "titan-server-node.service",
  "scripts/install.sh", "scripts/update.sh", "scripts/uninstall.sh",
  "user/index.html", "user/directadmin-gateway.raw", "images/directadmin-relay-client.mjs",
];
export const EXECUTABLE_FILES = [
  "install.sh", "update.sh", "uninstall.sh", "health.sh",
  "scripts/install.sh", "scripts/update.sh", "scripts/uninstall.sh",
  "user/index.html", "user/directadmin-gateway.raw",
];
const ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + " failed: " + (result.stderr.trim() || result.stdout.trim()));
  return result.stdout;
}

export function readPluginManifest(root) {
  const manifestPath = path.join(root, "plugin.conf");
  const content = fs.readFileSync(manifestPath, "utf8");
  const fields = Object.fromEntries(content.split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    if (index < 1) throw new Error("plugin.conf contains an invalid line");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (!ID_PATTERN.test(fields.name || "")) throw new Error("plugin.conf has an invalid plugin id");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(fields.version || "")) throw new Error("plugin.conf has an invalid version");
  return fields;
}

function validateSource(root) {
  const rootReal = fs.realpathSync(root);
  for (const name of PACKAGE_FILES) {
    const file = path.join(rootReal, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("package input must be a regular file: " + name);
    if (fs.realpathSync(file) !== file) throw new Error("package input escapes source root: " + name);
  }
  return readPluginManifest(rootReal);
}

export function packagePlugin({ sourceDir, outputDir }) {
  const root = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  const manifest = validateSource(root);
  fs.mkdirSync(output, { recursive: true });
  const archive = path.join(output, manifest.name + ".tar.gz");
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "titan-da-plugin-"));
  try {
    for (const name of PACKAGE_FILES) {
      const stagedFile = path.join(staging, name);
      fs.mkdirSync(path.dirname(stagedFile), { recursive: true });
      fs.copyFileSync(path.join(root, name), stagedFile, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(stagedFile, EXECUTABLE_FILES.includes(name) ? 0o755 : 0o644);
    }
    run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", staging, ...PACKAGE_FILES]);
    const bytes = fs.readFileSync(archive);
    return { plugin_id: manifest.name, version: manifest.version, archive, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function main() {
  const sourceDir = process.argv[2] || "apps/directadmin/server-node";
  const outputDir = process.argv[3] || "dist/directadmin";
  const result = packagePlugin({ sourceDir, outputDir });
  process.stdout.write(JSON.stringify({ packaged: true, ...result }) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
