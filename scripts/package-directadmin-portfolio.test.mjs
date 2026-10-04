import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ENABLED_PLUGINS, packagePortfolio } from "./package-directadmin-portfolio.mjs";
import { EXECUTABLE_FILES as SERVER_NODE_EXECUTABLE_FILES, PACKAGE_FILES as SERVER_NODE_PACKAGE_FILES, packagePlugin } from "./package-directadmin-plugin.mjs";
import { packageFiles as WORKFORCE_PACKAGE_FILES } from "../apps/directadmin/workforce/tools/package.mjs";
import { packageFiles as BRAND_STUDIO_PACKAGE_FILES } from "../apps/directadmin/brand-studio/tools/package.mjs";
import { renderEntry as renderBrandStudioEntry } from "../apps/directadmin/brand-studio/lib/entry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "titan-da-portfolio-test-"));
  const source = path.join(root, "plugin");
  const output = path.join(root, "dist");
  fs.mkdirSync(path.join(source, "admin"), { recursive: true });
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(source, "plugin.conf"), "name=Developer Portal\nversion=1.3.3\n");
  fs.writeFileSync(path.join(source, "admin/index.html"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(source, "scripts/update.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  fs.chmodSync(path.join(source, "scripts/update.sh"), 0o644);
  try { return run({ source, output }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function developerPortal(source, files = ["plugin.conf", "admin", "scripts/update.sh"]) {
  const executableFiles = ["admin/index.html", "scripts/update.sh"].filter((entry) => files.includes(entry) || files.includes(path.dirname(entry)));
  return {
    id: "titan_dev_access",
    displayName: "Developer Portal",
    legacyDisplayNames: { "1.2.0": "Titan Dev Access" },
    source: path.relative(path.resolve("scripts/.."), source),
    files,
    executableFiles,
  };
}

test("portfolio packaging emits a flat named archive, mode-safe entrypoint, and provenance", (t) => fixture(({ source, output }) => {
  const tarCheck = spawnSync("tar", ["--sort=name", "--version"], { encoding: "utf8" });
  if (tarCheck.status !== 0 && /not supported|unknown option/i.test(tarCheck.stderr)) return t.skip("GNU tar deterministic options unavailable");
  assert.equal(fs.statSync(path.join(source, "scripts/update.sh")).mode & 0o777, 0o644);
  const result = packagePortfolio({ outputDir: output, plugins: [developerPortal(source)] });
  assert.equal(result.artifacts[0].plugin_id, "titan_dev_access");
  assert.equal(path.basename(result.artifacts[0].archive), "titan_dev_access.tar.gz");
  const listing = spawnSync("tar", ["-tzf", result.artifacts[0].archive], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trim().split("\n").sort(), ["admin/", "admin/index.html", "plugin.conf", "scripts/update.sh"]);
  const details = spawnSync("tar", ["-tvzf", result.artifacts[0].archive], { encoding: "utf8" });
  assert.equal(details.status, 0, details.stderr);
  const updateEntry = details.stdout.split(/\r?\n/).find((line) => line.endsWith(" scripts/update.sh"));
  assert.match(updateEntry ?? "", /^-rwxr-xr-x\s/);
  const provenance = JSON.parse(fs.readFileSync(result.provenance, "utf8"));
  assert.equal(provenance.artifacts[0].plugin_id, "titan_dev_access");
  assert.equal(fs.existsSync(result.provenance), true);
}));

test("portfolio packaging refuses to replace an existing archive with different bytes", (t) => fixture(({ source, output }) => {
  const tarCheck = spawnSync("tar", ["--sort=name", "--version"], { encoding: "utf8" });
  if (tarCheck.status !== 0 && /not supported|unknown option/i.test(tarCheck.stderr)) return t.skip("GNU tar deterministic options unavailable");
  const plugin = developerPortal(source);
  const first = packagePortfolio({ outputDir: output, plugins: [plugin] });
  const archive = first.artifacts[0].archive;
  const original = fs.readFileSync(archive);
  fs.writeFileSync(path.join(source, "admin/index.html"), "<html>changed</html>\n");
  assert.throws(() => packagePortfolio({ outputDir: output, plugins: [plugin] }), /refusing to overwrite existing file/);
  assert.deepEqual(fs.readFileSync(archive), original);
}));

test("portfolio packaging rejects symlinked package input", (t) => fixture(({ source, output }) => {
  try { fs.symlinkSync("plugin.conf", path.join(source, "escape")); } catch (error) { if (error.code === "EPERM") return t.skip("symlink creation unavailable"); throw error; }
  assert.throws(() => packagePortfolio({ outputDir: output, plugins: [developerPortal(source, ["plugin.conf", "escape"])] }), /symlink/);
}));

test("portfolio packaging accepts the exact historical display-name/version pair", (t) => fixture(({ source, output }) => {
  const plugin = developerPortal(source, ["plugin.conf"]);
  fs.writeFileSync(path.join(source, "plugin.conf"), "name=Titan Dev Access\nversion=1.2.0\n");
  const result = packagePortfolio({ outputDir: output, plugins: [plugin] });
  assert.equal(result.artifacts[0].plugin_id, "titan_dev_access");
  assert.equal(path.basename(result.artifacts[0].archive), "titan_dev_access.tar.gz");
}));

test("portfolio packaging rejects a display-name mismatch without changing the stable plugin ID", (t) => fixture(({ source, output }) => {
  const plugin = developerPortal(source, ["plugin.conf"]);
  fs.writeFileSync(path.join(source, "plugin.conf"), "name=Unexpected Portal\nversion=1.3.3\n");
  assert.equal(plugin.id, "titan_dev_access");
  assert.throws(() => packagePortfolio({ outputDir: output, plugins: [plugin] }), /manifest display name mismatch/);
}));

test("portfolio packaging rejects the historical display name on the current version", (t) => fixture(({ source, output }) => {
  const plugin = developerPortal(source, ["plugin.conf"]);
  fs.writeFileSync(path.join(source, "plugin.conf"), "name=Titan Dev Access\nversion=1.3.3\n");
  assert.throws(() => packagePortfolio({ outputDir: output, plugins: [plugin] }), /manifest display name mismatch/);
}));

test("portfolio Server Node archive matches its canonical package owner byte-for-byte", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "titan-da-server-node-portfolio-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const descriptor = ENABLED_PLUGINS.find((plugin) => plugin.id === "titan-server-node");
  assert.ok(descriptor, "portfolio must include the canonical Server Node package");
  assert.deepEqual(descriptor.files, SERVER_NODE_PACKAGE_FILES, "portfolio file allowlist must come from the Server Node packager");
  assert.ok(SERVER_NODE_EXECUTABLE_FILES.includes("user/directadmin-gateway.raw"), "canonical RAW endpoint must remain executable");

  const portfolio = packagePortfolio({ outputDir: path.join(root, "portfolio"), plugins: [descriptor] });
  const canonical = packagePlugin({
    sourceDir: path.join(ROOT, descriptor.source),
    outputDir: path.join(root, "canonical"),
  });
  assert.equal(portfolio.artifacts[0].plugin_id, canonical.plugin_id);
  assert.equal(portfolio.artifacts[0].version, canonical.version);
  assert.equal(portfolio.artifacts[0].sha256, canonical.sha256);
  assert.deepEqual(fs.readFileSync(portfolio.artifacts[0].archive), fs.readFileSync(canonical.archive));
});

test("portfolio delegates Workforce packaging and pins its exact Server Node dependency", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "titan-da-workforce-portfolio-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const descriptor = ENABLED_PLUGINS.find((plugin) => plugin.id === "titan_workforce");
  assert.ok(descriptor, "portfolio must include the canonical Workforce package");
  assert.equal(descriptor.packager, "apps/directadmin/workforce/tools/package.mjs");
  assert.deepEqual(descriptor.files, WORKFORCE_PACKAGE_FILES);
  assert.deepEqual(descriptor.generatedFiles, ["images/sdk.mjs"]);
  assert.deepEqual(descriptor.dependencies, ["titan-server-node"]);

  const result = packagePortfolio({ outputDir: path.join(root, "portfolio") });
  const repeated = packagePortfolio({ outputDir: path.join(root, "portfolio-repeat") });
  assert.deepEqual(repeated.artifacts.map(({ plugin_id, sha256 }) => [plugin_id, sha256]), result.artifacts.map(({ plugin_id, sha256 }) => [plugin_id, sha256]));
  assert.deepEqual(fs.readFileSync(result.provenance), fs.readFileSync(repeated.provenance));
  const workforce = result.artifacts.find((artifact) => artifact.plugin_id === "titan_workforce");
  const titanWeb = result.artifacts.find((artifact) => artifact.plugin_id === "titan_web");
  const serverNode = result.artifacts.find((artifact) => artifact.plugin_id === "titan-server-node");
  assert.ok(workforce);
  assert.ok(titanWeb);
  assert.ok(serverNode);
  assert.equal(workforce.version, "0.1.6");
  assert.equal(path.basename(workforce.archive), "titan_workforce.tar.gz");
  assert.equal(workforce.archive_filename, "titan_workforce.tar.gz");
  assert.equal(fs.readFileSync(workforce.archive).length > 0, true);
  const workforceManifest = spawnSync("tar", ["-xOzf", workforce.archive, "plugin.conf"], { encoding: "utf8" });
  assert.equal(workforceManifest.status, 0, workforceManifest.stderr);
  const packagedWorkforceVersion = workforceManifest.stdout.match(/^version=(.+)$/m)?.[1];
  assert.equal(packagedWorkforceVersion, "0.1.6", "Workforce archive must contain the pinned release version");
  assert.equal(packagedWorkforceVersion, workforce.version, "portfolio version must match the packaged Workforce manifest");
  assert.equal(fs.readFileSync(`${workforce.archive}.sha256`, "utf8"), `${workforce.sha256}  titan_workforce.tar.gz\n`);
  assert.equal(titanWeb.version, "0.1.0");
  assert.equal(path.basename(titanWeb.archive), "titan_web.tar.gz");
  assert.equal(titanWeb.archive_filename, "titan_web.tar.gz");
  assert.equal(fs.readFileSync(`${titanWeb.archive}.sha256`, "utf8"), `${titanWeb.sha256}  titan_web.tar.gz\n`);
  const titanWebListing = spawnSync("tar", ["-tzf", titanWeb.archive], { encoding: "utf8" });
  assert.equal(titanWebListing.status, 0, titanWebListing.stderr);
  assert.deepEqual(titanWebListing.stdout.trim().split("\n"), [...BRAND_STUDIO_PACKAGE_FILES]);

  const provenance = JSON.parse(fs.readFileSync(result.provenance, "utf8"));
  const workforceRecord = provenance.artifacts.find((artifact) => artifact.plugin_id === "titan_workforce");
  assert.deepEqual(workforceRecord.dependencies, [{
    plugin_id: serverNode.plugin_id,
    version: serverNode.version,
    archive_filename: "titan-server-node.tar.gz",
    sha256: serverNode.sha256,
  }]);
  assert.equal(workforceRecord.build_inputs.sdk.source, "packages/titan-platform/src/directadmin-plugin.ts");
  const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(workforceRecord.build_inputs.sdk.compiler, `esbuild@${rootPackage.devDependencies.esbuild}`);
  assert.deepEqual(workforceRecord.build_inputs.sdk.compiler_flags, ["--bundle", "--format=esm", "--platform=browser", "--target=es2022"]);
  assert.match(workforceRecord.build_inputs.sdk.source_sha256, /^[a-f0-9]{64}$/);
  assert.match(workforceRecord.build_inputs.sdk.compiled_sha256, /^[a-f0-9]{64}$/);
  for (const artifact of result.artifacts) {
    assert.equal(fs.readFileSync(`${artifact.archive}.sha256`, "utf8"), `${artifact.sha256}  ${path.basename(artifact.archive)}\n`);
  }
});

test("portfolio refuses to replace a previously emitted Workforce archive", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "titan-da-workforce-immutable-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdkModule = path.join(root, "canonical-sdk.mjs");
  const outputDir = path.join(root, "portfolio");
  const sdkSource = "export class DirectAdminCockpitSession {}\nexport const mountDirectAdminProjection = () => {};\nexport const validateDirectAdminPluginPackage = () => ({ valid: true });\nexport const assertPluginCanBeInstalled = () => true;\n";
  fs.writeFileSync(sdkModule, sdkSource);
  const first = packagePortfolio({ outputDir, workforceSdkModulePath: sdkModule });
  const archive = first.artifacts.find((artifact) => artifact.plugin_id === "titan_workforce").archive;
  const original = fs.readFileSync(archive);
  fs.writeFileSync(sdkModule, `${sdkSource}export const changed = true;\n`);
  assert.throws(() => packagePortfolio({ outputDir, workforceSdkModulePath: sdkModule }), /refusing to overwrite existing file/);
  assert.deepEqual(fs.readFileSync(archive), original);
});


test("portfolio registers Titan Web under its stable ID with shared SDK and Server Node dependency", () => {
  const descriptor = ENABLED_PLUGINS.find((plugin) => plugin.id === "titan_web");
  assert.ok(descriptor, "portfolio must include the canonical Titan Web plugin");
  assert.equal(descriptor.displayName, "Titan Web");
  assert.equal(descriptor.source, "apps/directadmin/brand-studio");
  assert.ok(descriptor.files.includes("plugin.conf"));
  assert.ok(descriptor.files.includes("admin/index.html"));
  assert.ok(descriptor.files.includes("reseller/index.html"));
  assert.ok(descriptor.files.includes("user/index.html"));
  assert.ok(descriptor.files.includes("hooks/admin_txt.html"));
  assert.ok(descriptor.files.includes("images/sdk.mjs"));
  assert.deepEqual(descriptor.generatedFiles, ["images/sdk.mjs"]);
  assert.deepEqual(descriptor.dependencies, ["titan-server-node"]);
  assert.equal(descriptor.packager, "apps/directadmin/brand-studio/tools/package.mjs");
  assert.deepEqual(descriptor.files, BRAND_STUDIO_PACKAGE_FILES);
  const source = path.resolve(ROOT, descriptor.source);
  for (const file of descriptor.files) {
    if (!descriptor.generatedFiles.includes(file)) assert.ok(fs.existsSync(path.join(source, file)), `Titan Web package source is missing ${file}`);
  }
  const manifest = fs.readFileSync(path.join(source, "plugin.conf"), "utf8");
  assert.match(manifest, /^name=Titan Web$/m);
  assert.match(manifest, /^version=\d+\.\d+\.\d+$/m);
});

test("Titan Web role entrypoints load the authenticated read-only cockpit and reject unknown roles", () => {
  const sdkModule = "export const DirectAdminCockpitSession = class {}; export const mountDirectAdminProjection = () => {};";
  for (const role of ["admin", "reseller", "user"]) {
    const html = renderBrandStudioEntry(role, { sdkModule });
    assert.match(html, new RegExp(`data-role="${role}"`));
    assert.match(html, /<script type="importmap">/);
    assert.match(html, /titan-sdk/);
    assert.match(html, /mountDirectAdminProjection/);
    assert.equal(/<script[^>]+src=/i.test(html), false);
    assert.equal(html.includes("https://"), false);
    assert.equal(html.includes("http://"), false);
  }
  assert.throws(() => renderBrandStudioEntry("root"), /unsupported DirectAdmin role/);
});
