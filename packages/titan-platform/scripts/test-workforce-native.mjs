import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(packageRoot, ".test-dist");
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const tests = [
  "tests/workforce-native-contracts.test.mjs",
  "tests/workforce-native-reception.test.mjs",
  "tests/workforce-native-sales.test.mjs",
  "tests/workforce-native-booking.test.mjs",
  "tests/workforce-native-scheduling.test.mjs",
  "tests/workforce-native-jobs.test.mjs",
  "tests/workforce-native-customer-care.test.mjs",
  "tests/workforce-native-workflow.test.mjs",
  "tests/workforce-native-pass10-certification.test.mjs",
];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync(outputDirectory, { recursive: true, force: true });
try {
  run(packageManager, [
    "exec",
    "tsc",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--strict",
    "--skipLibCheck",
    "--rootDir",
    "src",
    "--outDir",
    ".test-dist",
    "src/workforce-native/index.ts",
  ]);
  run(process.execPath, ["--test", ...tests]);
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
