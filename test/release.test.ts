import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CLI_VERSION, USER_AGENT } from "../src/cli.js";

const execFileAsync = promisify(execFile);

const packageRoot = new URL("../../", import.meta.url);

interface PackageManifest {
  readonly version: string;
  readonly private?: boolean;
  readonly repository?: {
    readonly url?: string;
  };
  readonly publishConfig?: {
    readonly access?: string;
    readonly registry?: string;
  };
  readonly bin?: Record<string, string>;
  readonly files?: readonly string[];
  readonly engines?: Record<string, string>;
}

async function readManifest(): Promise<PackageManifest> {
  const raw = await readFile(new URL("package.json", packageRoot), "utf8");
  return JSON.parse(raw) as PackageManifest;
}

// A release that reports the wrong version is worse than a release that fails:
// every JSON envelope, every user agent, and every bug report points at code
// that is not running. These tests make a forgotten bump a red build.

test("the compiled CLI version matches the package manifest", async () => {
  const manifest = await readManifest();
  assert.equal(
    CLI_VERSION,
    manifest.version,
    `CLI_VERSION (${CLI_VERSION}) and package.json version (${manifest.version}) disagree. ` +
      `Both must be bumped together.`,
  );
});

test("the outgoing user agent carries the released version", async () => {
  const manifest = await readManifest();
  assert.ok(
    USER_AGENT.includes(`arxiv-agent-cli/${manifest.version}`),
    `USER_AGENT (${USER_AGENT}) must identify version ${manifest.version} to arXiv.`,
  );
});

test("the published bin entry resolves to a built executable that reports its version", async () => {
  const manifest = await readManifest();
  const binPath = manifest.bin?.["arxiv"];
  assert.ok(binPath, "package.json must declare an `arxiv` bin entry.");
  const executable = fileURLToPath(new URL(binPath, packageRoot));
  const result = await execFileAsync(process.execPath, [executable, "--version"]);
  assert.equal(result.stdout.trim(), manifest.version);
});

test("the package ships the built CLI and the skill, and never the test tree", async () => {
  const manifest = await readManifest();
  const files = manifest.files ?? [];
  assert.ok(files.includes("dist/src"), "the built CLI must be published.");
  assert.ok(files.includes("skills"), "the agent skill must be published.");
  assert.ok(
    !files.some((entry) => entry.startsWith("dist/test") || entry === "dist"),
    "the compiled test tree must stay out of the tarball.",
  );
});

test("the manifest can publish only as a public npmjs package from this repository", async () => {
  const manifest = await readManifest();
  assert.notEqual(manifest.private, true, "the release manifest must not be private.");
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.publishConfig?.registry, "https://registry.npmjs.org/");
  assert.equal(
    manifest.repository?.url,
    "git+https://github.com/PlunderStruck/arxiv-agent-cli.git",
  );
});

test("the privileged release job uses OIDC without building or reading an npm token", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/release.yml", packageRoot),
    "utf8",
  );
  assert.match(workflow, /\bid-token:\s*write\b/);
  assert.match(workflow, /\benvironment:\s*npm\b/);
  assert.match(workflow, /npm publish "\$tarball" --access public/);
  assert.doesNotMatch(workflow, /\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/);

  const privilegedJob = workflow.split(/\n  publish:\s*\n/, 2)[1];
  assert.ok(privilegedJob, "release workflow must contain a publish job.");
  assert.doesNotMatch(privilegedJob, /\bnpm ci\b|\bnpm run\b|actions\/checkout@/);
});

test("the declared node floor is the floor the release is verified against", async () => {
  const manifest = await readManifest();
  const declared = manifest.engines?.["node"];
  assert.ok(declared, "package.json must declare a supported node range.");
  const floor = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(declared);
  assert.ok(
    floor,
    `engines.node (${declared}) must be an exact lower bound such as ">=24.15.0" so CI can pin it.`,
  );
  const [major, minor, patch] = [
    Number(floor[1]),
    Number(floor[2]),
    Number(floor[3]),
  ];
  const running = process.versions.node.split(".").map(Number);
  const meetsFloor =
    running[0]! > major ||
    (running[0] === major &&
      (running[1]! > minor || (running[1] === minor && running[2]! >= patch)));
  assert.ok(
    meetsFloor,
    `running node ${process.versions.node} is below the declared floor ${declared}.`,
  );
});
