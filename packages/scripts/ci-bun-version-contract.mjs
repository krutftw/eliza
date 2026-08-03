#!/usr/bin/env node
/**
 * Contract for the pinned Bun runtime (#13402 item 2 + item 5, #17044). Keeps
 * every authoritative install path in the repository on ONE published concrete
 * Bun version so a stale bump, an unpublished version, or a regression back to
 * floating `canary`/`latest` cannot slip through unnoticed.
 *
 * Background: `bun install --frozen-lockfile` fails when Bun reserializes
 * bun.lock to lockfileVersion 2, which floating `canary`/`latest` do on their
 * own cadence (#11184/#9454), and an unpublished packageManager version 404s
 * during setup (#17044 — bare `setup-bun` resolving the repo declaration died
 * on `bun@1.4.0`). The canonical value lives in `.github/ci-bun-version.json`;
 * GitHub Actions cannot interpolate a file into `${{ }}` at parse time, so the
 * literal is repeated at each site and this contract is what guarantees the
 * copies never drift from the source of truth.
 *
 * Checked statically against the tracked tree (git ls-files when the root is a
 * git checkout, so populated submodules and untracked build output cannot
 * change the result; a plain directory walk only for synthetic fixture trees):
 *
 *   1. Every `bun-version:`/`BUN_VERSION:` value in workflows, composite
 *      actions, and workflow-shaped templates outside `.github` is the
 *      canonical pin, an expression that RESOLVES to a validated same-file
 *      declaration, or an explicitly allowlisted floating cell. Concrete
 *      divergence, floating values, expressions with no backing declaration,
 *      and unparseable syntax all fail.
 *   2. Every `oven-sh/setup-bun` use is pinned to a reviewed commit SHA and
 *      wires an explicit `bun-version` — the action's implicit default is
 *      `latest`, so an absent key is a floating runtime.
 *   3. Every `bun.sh/install` shell install and every oven-sh Bun release
 *      artifact URL in Dockerfiles, shell scripts, YAML runtime manifests,
 *      cloud-init templates, and .mjs installers pins the canonical version;
 *      `releases/latest` is always floating. A presence-only `command -v bun`
 *      guard may not preserve an arbitrary preinstalled runtime; it must compare
 *      `bun --version` with the canonical pin. Dockerfile `ARG/ENV BUN_VERSION`
 *      defaults and `FROM oven/bun:<tag>` base images must be canonical.
 *   4. Every `packageManager` declaring Bun equals `bun@<canonical>`, and the
 *      root `@types/bun`/`bun-types` anchors equal the canonical version
 *      exactly. Non-root workspace type declarations are classified in the
 *      inventory (exact-canonical / compatible-range / drift / unparseable)
 *      but stay advisory: they are compatibility signals, not runtime
 *      selectors (#17044 scope).
 *   5. A composite action declaring a `bun-version` input must default it to
 *      the canonical pin, since callers relying on the default otherwise
 *      float silently — the previous `canary` default covered 112 call sites.
 *   6. A FLOATING_ALLOWLIST entry is additive-only: it needs a non-empty
 *      reason AND a canonical lane in the same file, so a sanctioned canary
 *      cell can only ever run in addition to the pinned runtime, never as
 *      the default or sole one.
 *   7. Deterministic gate and deploy workflows (GATE_WORKFLOWS) additionally
 *      must wire the canonical literal directly, so required checks never
 *      depend on indirection to become reproducible.
 *
 * The full scan is returned (and writable via --inventory) as a
 * machine-readable inventory of every resolution site and its classification,
 * including the deliberately excluded surfaces. Embedded platform Bun builds
 * (the Android staging pipeline and the RISC-V custom build) are a separate,
 * device-proven shipping boundary: they are inventoried as excluded, never
 * version-checked here.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const VERSION_FILE = ".github/ci-bun-version.json";
const WORKFLOW_DIR = ".github/workflows";
const ACTIONS_DIR = ".github/actions";

// Every oven-sh/setup-bun ref must resolve to one of these reviewed commits.
// 0c5077e5 is the v2 tag (verified equal to the upstream tag object); adding a
// new SHA here is the review step for adopting a new action version.
const REVIEWED_SETUP_BUN_SHAS = new Set([
  "0c5077e51419868618aeaa5fe8019c62421857d6",
]);

// Non-authoritative floating cells, e.g. an upstream Bun compatibility matrix
// that runs IN ADDITION to the pinned lane. Each entry scopes one file, job,
// and exact floating matrix value, and must carry a non-empty reason. The same
// job's matrix must also contain the canonical pin (additive-only — a canary
// can never borrow a stable lane from some unrelated job). Empty by design: no
// surface currently has a sanctioned reason to float, and an entry added here
// is a reviewable diff rather than silent drift.
const FLOATING_ALLOWLIST = [];

// Deliberately excluded surfaces, inventoried so the exclusion is visible
// rather than silent. The embedded entries are the Android/RISC-V Bun binary
// shipping boundary #17044 scopes out (their versions are proven on-device,
// not by text equality); the advisory entry is developer-machine guidance,
// not a repository runtime selector.
const EXCLUDED_SURFACES = [
  {
    prefix: "packages/app-core/scripts/bun-riscv64/",
    classification: "embedded-boundary-excluded",
    reason: "custom RISC-V Bun build with its own device-proof record",
  },
  {
    prefix: "packages/app-core/scripts/lib/stage-android-agent.mjs",
    classification: "embedded-boundary-excluded",
    reason: "Android embedded Bun staging; channel-driven, device-proven",
  },
  {
    prefix: "packages/app-core/src/cli/doctor/checks.ts",
    classification: "advisory-excluded",
    reason: "doctor fix hint for the developer's machine, not a repo runtime",
  },
  {
    prefix: "packages/scripts/ci-bun-version-contract.mjs",
    classification: "contract-self-excluded",
    reason: "this contract's own policy text names the install idiom",
  },
];

// Required, scheduled, and deploy-critical install lanes that must wire the
// concrete pin directly (not merely resolve through indirection). The required
// `ci-ok` aggregate (test.yml), main gate (ci.yaml), and canonical cloud
// deploy are the load-bearing paths.
const GATE_WORKFLOWS = [
  "ci.yaml",
  "test.yml",
  "develop-pr.yml",
  "cloud-cf-deploy.yml",
  "app-aesthetic-audit.yml",
  "develop-exhaustive.yml",
  "ci-full-matrix-proof.yml",
  "benchmark-tests.yml",
  "windows-desktop-preload-smoke.yml",
  "feed-env-audit.yml",
];

// Both the post-merge suite and the required develop PR gate must execute the
// contract and publish its exact-head inventory. Keeping the PR lane here is
// what prevents a runtime drift from merging before test.yml runs on develop.
const CONTRACT_ENFORCEMENT_WORKFLOWS = new Set(["test.yml", "develop-pr.yml"]);

// A concrete pin: a plain semver, optionally with a prerelease/build suffix.
// `canary`, `latest`, and `${{ ... }}` expressions deliberately do not match.
const CONCRETE_PIN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;
const FLOATING = new Set(["canary", "latest"]);

// Fixture-tree walk only (real repos are enumerated via git ls-files);
// skipping dependency/build dirs keeps synthetic trees cheap to scan.
const WALK_SKIP = new Set([
  "node_modules",
  ".git",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  "target",
]);

function stripQuotes(raw) {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

// Extract every `bun-version:`/`BUN_VERSION:` value wired in a YAML file as
// `{ key, raw, line, origin }`, with inline comments and quotes stripped.
// Handles the scalar form, the flow list (`bun-version: ["1.3.14"]`, matrix
// cells), and the block list (`bun-version:` followed by `- value` items);
// `origin` distinguishes list cells (matrix declarations) from scalar wiring
// so expression resolution can demand the right declaration shape. Only real
// YAML key wiring counts — a version named in a `#` comment is never a pin.
export function bunVersionValues(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(
      /^(\s*)(?:-\s+)?(bun-version|BUN_VERSION):\s*(.*?)\s*$/,
    );
    if (!match) continue;
    const [, indent, key] = match;
    const raw = match[3].replace(/\s+#.*$/, "").trim();
    if (raw === "" || raw === "#") {
      // Block list: consume the more-indented `- item` lines that follow.
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^(\s*)-\s+(.+?)\s*$/);
        if (!item || item[1].length <= indent.length) break;
        out.push({
          key,
          raw: stripQuotes(item[2].replace(/\s+#.*$/, "").trim()),
          line: j + 1,
          origin: "block-list",
        });
      }
      continue;
    }
    if (raw.startsWith("[")) {
      // Flow list: split the bracketed cells.
      const inner = raw.replace(/^\[/, "").replace(/\]$/, "");
      for (const cell of inner.split(",")) {
        const value = stripQuotes(cell.trim());
        if (value)
          out.push({ key, raw: value, line: i + 1, origin: "flow-list" });
      }
      continue;
    }
    out.push({ key, raw: stripQuotes(raw), line: i + 1, origin: "scalar" });
  }
  return out;
}

function isExpression(raw) {
  return raw.includes("${{");
}

const ENV_EXPRESSION = /^\$\{\{\s*env\.BUN_VERSION\s*\}\}$/;
const MATRIX_EXPRESSION = /^\$\{\{\s*matrix\.bun-version\s*\}\}$/;
const INPUTS_EXPRESSION = /^\$\{\{\s*inputs\.bun-version\s*\}\}$/;

function isAllowlisted(allowlist, file, job, value) {
  return allowlist.some(
    (entry) =>
      entry.file === file && entry.job === job && entry.value === value,
  );
}

function scalarKey(pair) {
  return isScalar(pair.key) && typeof pair.key.value === "string"
    ? pair.key.value
    : undefined;
}

function mappingValue(mapping, key) {
  if (!isMap(mapping)) return undefined;
  return mapping.items.find((pair) => scalarKey(pair) === key)?.value;
}

function scalarValue(node) {
  if (!isScalar(node)) return null;
  if (typeof node.value === "string") return node.value;
  if (node.value === null || node.value === undefined) return null;
  return String(node.value);
}

function lineAtOffset(text, offset) {
  return text.slice(0, Math.max(0, offset)).split("\n").length;
}

function nodeLines(text, node) {
  if (!Array.isArray(node?.range)) return { start: 1, end: 1 };
  return {
    start: lineAtOffset(text, node.range[0]),
    end: lineAtOffset(text, node.range[1]),
  };
}

function versionNodes(node) {
  if (isSeq(node)) return node.items.filter((item) => item !== null);
  return node === undefined ? [] : [node];
}

function collectVariableScalars(node, text, context, out) {
  if (isScalar(node)) {
    const value = scalarValue(node);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable syntax, not a JS template
    if (value?.includes("${BUN_VERSION}")) {
      const range = nodeLines(text, node);
      out.push({ ...context, ...range, value });
    }
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      collectVariableScalars(pair.value, text, context, out);
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      collectVariableScalars(item, text, context, out);
    }
  }
}

function parseYamlSurface(rel, kind, text) {
  const document = parseDocument(text, {
    merge: false,
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${rel}: tracked ${kind} failed to parse as YAML — cannot verify its Bun scopes (${document.errors[0].message})`,
    );
  }
  if (!isMap(document.contents)) {
    throw new Error(
      `${rel}: tracked ${kind} must have a YAML mapping root to verify its Bun scopes.`,
    );
  }

  const values = [];
  const setupBunUses = [];
  const variableUses = [];
  let compositeDefault = null;

  const addValue = ({
    node,
    key,
    origin,
    job,
    step,
    envBinding,
    matrixCells,
    inputDefault,
  }) => {
    for (const item of versionNodes(node)) {
      values.push({
        key,
        raw: scalarValue(item),
        line: nodeLines(text, item).start,
        origin,
        job,
        step,
        envBinding,
        matrixCells: matrixCells ?? [],
        inputDefault,
      });
    }
  };

  const collectSteps = ({
    steps,
    job,
    workflowEnv,
    jobEnv,
    matrixCells,
    inputDefault,
  }) => {
    if (!isSeq(steps)) return;
    for (const [step, stepNode] of steps.items.entries()) {
      if (!isMap(stepNode)) continue;
      const stepEnv = mappingValue(
        mappingValue(stepNode, "env"),
        "BUN_VERSION",
      );
      const envBinding = stepEnv ?? jobEnv ?? workflowEnv;
      if (stepEnv !== undefined) {
        addValue({
          node: stepEnv,
          key: "BUN_VERSION",
          origin: "step-env",
          job,
          step,
          envBinding: undefined,
          matrixCells,
        });
      }
      const withNode = mappingValue(stepNode, "with");
      const bunVersion = mappingValue(withNode, "bun-version");
      if (bunVersion !== undefined) {
        addValue({
          node: bunVersion,
          key: "bun-version",
          origin: "step-with",
          job,
          step,
          envBinding,
          matrixCells,
          inputDefault,
        });
      }

      const usesNode = mappingValue(stepNode, "uses");
      const uses = scalarValue(usesNode);
      if (uses?.startsWith("oven-sh/setup-bun@")) {
        setupBunUses.push({
          ref: uses.slice("oven-sh/setup-bun@".length),
          line: nodeLines(text, usesNode).start,
          bunVersion,
        });
      }

      const variableContext = {
        job,
        step,
        envBinding,
        matrixCells,
        inputDefault,
      };
      collectVariableScalars(
        mappingValue(stepNode, "run"),
        text,
        variableContext,
        variableUses,
      );
      collectVariableScalars(withNode, text, variableContext, variableUses);
    }
  };

  const root = document.contents;
  if (kind === "action") {
    const input = mappingValue(mappingValue(root, "inputs"), "bun-version");
    const defaultNode = mappingValue(input, "default");
    if (input !== undefined) {
      compositeDefault = {
        raw: scalarValue(defaultNode),
        line: nodeLines(text, defaultNode ?? input).start,
      };
    }
    const runs = mappingValue(root, "runs");
    collectSteps({
      steps: mappingValue(runs, "steps"),
      job: "<composite>",
      workflowEnv: undefined,
      jobEnv: undefined,
      matrixCells: [],
      inputDefault: defaultNode,
    });
    return { values, setupBunUses, variableUses, compositeDefault };
  }

  const workflowEnv = mappingValue(mappingValue(root, "env"), "BUN_VERSION");
  if (workflowEnv !== undefined) {
    addValue({
      node: workflowEnv,
      key: "BUN_VERSION",
      origin: "workflow-env",
      job: null,
      envBinding: undefined,
      matrixCells: [],
    });
  }
  const jobs = mappingValue(root, "jobs");
  if (!isMap(jobs)) return { values, setupBunUses, variableUses };
  for (const pair of jobs.items) {
    const job = scalarKey(pair);
    const jobNode = pair.value;
    if (job === undefined || !isMap(jobNode)) continue;
    const jobEnv = mappingValue(mappingValue(jobNode, "env"), "BUN_VERSION");
    const matrixNode = mappingValue(
      mappingValue(mappingValue(jobNode, "strategy"), "matrix"),
      "bun-version",
    );
    const matrixCells = versionNodes(matrixNode);
    if (jobEnv !== undefined) {
      addValue({
        node: jobEnv,
        key: "BUN_VERSION",
        origin: "job-env",
        job,
        envBinding: undefined,
        matrixCells,
      });
    }
    if (matrixNode !== undefined) {
      addValue({
        node: matrixNode,
        key: "bun-version",
        origin: "matrix-cell",
        job,
        envBinding: jobEnv ?? workflowEnv,
        matrixCells,
      });
    }
    const jobWith = mappingValue(jobNode, "with");
    const jobBunVersion = mappingValue(jobWith, "bun-version");
    if (jobBunVersion !== undefined) {
      addValue({
        node: jobBunVersion,
        key: "bun-version",
        origin: "job-with",
        job,
        envBinding: jobEnv ?? workflowEnv,
        matrixCells,
      });
    }
    collectSteps({
      steps: mappingValue(jobNode, "steps"),
      job,
      workflowEnv,
      jobEnv,
      matrixCells,
      inputDefault: undefined,
    });
  }
  return { values, setupBunUses, variableUses };
}

// Minimal range check for the workspace type-anchor classification. Only the
// syntaxes that appear in this repo are modeled (`*`, exact, `^`, `~`);
// anything else classifies as unparseable so a new syntax surfaces in the
// inventory instead of being silently misfiled.
export function classifyTypeRange(range, canonical) {
  if (range === canonical) return "exact-canonical";
  if (range === "*") return "compatible-range";
  const caret = range.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
  const tilde = range.match(/^~(\d+)\.(\d+)\.(\d+)$/);
  const exact = range.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const target = canonical.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!target) return "unparseable";
  const [tMaj, tMin, tPat] = target.slice(1).map(Number);
  const atLeast = (maj, min, pat) =>
    tMaj > maj ||
    (tMaj === maj && (tMin > min || (tMin === min && tPat >= pat)));
  if (caret) {
    const [maj, min, pat] = caret.slice(1).map(Number);
    return tMaj === maj && atLeast(maj, min, pat)
      ? "compatible-range"
      : "drift";
  }
  if (tilde) {
    const [maj, min, pat] = tilde.slice(1).map(Number);
    return tMaj === maj && tMin === min && tPat >= pat
      ? "compatible-range"
      : "drift";
  }
  if (exact) return "drift";
  return "unparseable";
}

// Tracked-file enumeration. A real checkout is read through git so the scan
// matches the checked-in tree exactly; the recursive walk exists only for the
// synthetic fixture trees the tests build (no `.git` there, by construction).
function trackedFiles(repoRoot) {
  if (existsSync(join(repoRoot, ".git"))) {
    const output = execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return output.split("\0").filter((entry) => entry.length > 0);
  }
  const found = [];
  const stack = [repoRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) stack.push(join(dir, entry.name));
      } else {
        found.push(
          join(dir, entry.name)
            .slice(repoRoot.length + 1)
            .split(sep)
            .join("/"),
        );
      }
    }
  }
  return found.sort();
}

function excludedSurface(rel) {
  return EXCLUDED_SURFACES.find((entry) => rel.startsWith(entry.prefix));
}

// Validate every invariant against a repo layout rooted at `repoRoot`. Pure
// (no process exit / no console) so tests can drive it against fixture trees.
// Collects every violation before throwing one aggregate error, so a version
// bump sees the complete list of stale sites in a single run. Returns the
// canonical version and the full classified inventory on success. Read and
// parse failures on tracked files are deliberately NOT caught: a surface that
// cannot be inspected must fail the contract, not vanish from the inventory.
export function runContract(repoRoot = DEFAULT_REPO_ROOT, overrides = {}) {
  const allowlist = overrides.floatingAllowlist ?? FLOATING_ALLOWLIST;
  const reviewedShas =
    overrides.reviewedSetupBunShas ?? REVIEWED_SETUP_BUN_SHAS;
  const read = (rel) => readFileSync(resolve(repoRoot, rel), "utf8");

  const manifest = JSON.parse(read(VERSION_FILE));
  const canonical = manifest.version;
  if (typeof canonical !== "string" || !CONCRETE_PIN.test(canonical)) {
    throw new Error(
      `${VERSION_FILE}: "version" must be a concrete Bun pin (semver), got ${JSON.stringify(canonical)}`,
    );
  }
  if (FLOATING.has(canonical)) {
    throw new Error(`${VERSION_FILE}: "version" must not float (${canonical})`);
  }

  const violations = [];
  const inventory = [];
  const record = (site) => inventory.push(site);
  const violate = (message) => violations.push(message);

  for (const entry of allowlist) {
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      violate(
        `FLOATING_ALLOWLIST entry for ${entry.file ?? "<missing file>"} has no reason — a sanctioned floating cell must say why it exists.`,
      );
    }
    if (typeof entry.job !== "string" || entry.job.trim().length === 0) {
      violate(
        `FLOATING_ALLOWLIST entry for ${entry.file ?? "<missing file>"} has no job scope — sanctioned compatibility cells must name their owning matrix job.`,
      );
    }
  }

  const tracked = trackedFiles(repoRoot);

  // --- YAML surfaces: workflows, composite actions, and workflow-shaped
  // templates outside .github (project/plugin CI templates are authoritative
  // runtime declarations for whoever instantiates them). ---
  const yamlFiles = [];
  for (const rel of tracked) {
    if (rel.startsWith(`${WORKFLOW_DIR}/`) && /\.ya?ml$/.test(rel)) {
      yamlFiles.push({ rel, kind: "workflow" });
    } else if (
      rel.startsWith(`${ACTIONS_DIR}/`) &&
      /\/action\.ya?ml$/.test(rel)
    ) {
      yamlFiles.push({ rel, kind: "action" });
    } else if (
      !rel.startsWith(".github/") &&
      /\.ya?ml$/.test(rel) &&
      !excludedSurface(rel)
    ) {
      const text = read(rel);
      if (/^\s*(?:-\s+)?(bun-version|BUN_VERSION):/m.test(text)) {
        yamlFiles.push({ rel, kind: "workflow", text });
      }
    }
  }

  const scannedYamlFiles = new Set(yamlFiles.map(({ rel }) => rel));

  for (const { rel, kind, text: preread } of yamlFiles) {
    const text = preread ?? read(rel);
    const analysis = parseYamlSurface(rel, kind, text);
    const values = analysis.values;

    const matrixCellIsValidated = (node, job) => {
      const value = scalarValue(node);
      return (
        value === canonical ||
        (FLOATING.has(value) && isAllowlisted(allowlist, rel, job, value))
      );
    };
    const bindingResolves = (node, site) => {
      const value = scalarValue(node);
      if (value === canonical) return true;
      if (MATRIX_EXPRESSION.test(value ?? "")) {
        return (
          site.matrixCells.length > 0 &&
          site.matrixCells.every((cell) =>
            matrixCellIsValidated(cell, site.job),
          )
        );
      }
      if (kind === "action" && INPUTS_EXPRESSION.test(value ?? "")) {
        return scalarValue(site.inputDefault) === canonical;
      }
      return false;
    };

    // Invariant 1: every wired value is canonical, resolvable, or allowlisted.
    for (const valueSite of values) {
      const { key, raw, line, origin, job } = valueSite;
      const site = {
        surface: `${kind}-version`,
        file: rel,
        line,
        key,
        origin,
        value: raw,
        ...(job === null || job === undefined ? {} : { job }),
      };
      if (typeof raw === "string" && isExpression(raw)) {
        // Expressions are resolved inside the actual job/step scope parsed
        // from the YAML AST. A declaration in another job cannot satisfy the
        // expression, and every matrix cell in the owning job must itself be
        // canonical or an explicitly sanctioned sibling compatibility lane.
        let resolvable = false;
        let missing = "";
        if (ENV_EXPRESSION.test(raw)) {
          resolvable = bindingResolves(valueSite.envBinding, valueSite);
          missing =
            valueSite.envBinding === undefined
              ? `job "${job ?? "<workflow>"}" has no effective BUN_VERSION declaration; no BUN_VERSION declaration is visible in its workflow/job/step scope`
              : `job "${job ?? "<workflow>"}" has a BUN_VERSION declaration that does not resolve to the canonical ${canonical}`;
        } else if (MATRIX_EXPRESSION.test(raw)) {
          resolvable =
            valueSite.matrixCells.length > 0 &&
            valueSite.matrixCells.every((cell) =>
              matrixCellIsValidated(cell, job),
            );
          missing = `job "${job ?? "<workflow>"}" has no bun-version matrix cells that can be proven canonical or sanctioned`;
        } else if (kind === "action" && INPUTS_EXPRESSION.test(raw)) {
          resolvable = scalarValue(valueSite.inputDefault) === canonical;
          missing =
            "no canonical bun-version input default declared in this action";
        } else {
          missing =
            "only effective job-scoped env.BUN_VERSION / matrix.bun-version / composite inputs.bun-version indirection is checkable";
        }
        record({
          ...site,
          classification: resolvable
            ? "resolvable-expression"
            : "unbound-expression",
        });
        if (!resolvable) {
          violate(
            `${rel}:${line}: wires Bun via unbound expression ${raw} — ${missing}, so this cannot be proven pinned.`,
          );
        }
        continue;
      }
      if (FLOATING.has(raw)) {
        const scopeMatched = isAllowlisted(allowlist, rel, job, raw);
        const sanctioned = scopeMatched && origin === "matrix-cell";
        record({
          ...site,
          classification: scopeMatched ? "allowlisted-floating" : "floating",
        });
        if (!scopeMatched) {
          violate(
            `${rel}:${line}: job "${job ?? "<workflow>"}" wires floating Bun "${raw}". Every authoritative lane must stay pinned to ${canonical} (${VERSION_FILE}); a deliberate extra compatibility matrix cell needs a file/job-scoped FLOATING_ALLOWLIST entry.`,
          );
        } else if (
          !sanctioned ||
          !valueSite.matrixCells.some((cell) => scalarValue(cell) === canonical)
        ) {
          violate(
            `${rel}:${line}: allowlisted floating "${raw}" in job "${job ?? "<workflow>"}" has no canonical sibling matrix lane — it must run in addition to the canonical ${canonical} lane in the same job, never borrow a stable lane from another job or become the default/sole runtime (#17044).`,
          );
        }
        continue;
      }
      if (!CONCRETE_PIN.test(raw)) {
        record({ ...site, classification: "unparseable" });
        violate(
          `${rel}:${line}: unparseable Bun version value ${JSON.stringify(raw)} — pin the canonical ${canonical} (${VERSION_FILE}).`,
        );
        continue;
      }
      record({
        ...site,
        classification: raw === canonical ? "canonical" : "divergent",
      });
      if (raw !== canonical) {
        violate(
          `${rel}:${line}: pins Bun ${raw}, but the canonical CI Bun version is ${canonical} (${VERSION_FILE}). Update this site or bump the source of truth — keep them in lockstep.`,
        );
      }
    }

    // Invariant 2: setup-bun refs are reviewed SHAs and never implicit. The
    // owning step and its `with` mapping come from the parsed YAML tree.
    for (const use of analysis.setupBunUses) {
      const { ref, line, bunVersion } = use;
      const refSite = {
        surface: "setup-bun-ref",
        file: rel,
        line,
        value: ref,
      };
      if (!reviewedShas.has(ref)) {
        record({ ...refSite, classification: "unreviewed-ref" });
        violate(
          `${rel}:${line}: oven-sh/setup-bun@${ref} is not pinned to a reviewed commit SHA — mutable tags can repoint. Pin one of: ${[...reviewedShas].join(", ")}.`,
        );
      } else {
        record({ ...refSite, classification: "reviewed-sha" });
      }
      if (bunVersion === undefined) {
        record({
          surface: "setup-bun-version",
          file: rel,
          line,
          value: null,
          classification: "implicit",
        });
        violate(
          `${rel}:${line}: oven-sh/setup-bun use wires no bun-version — the action's implicit default is floating "latest". Pin ${canonical} (${VERSION_FILE}).`,
        );
      }
    }

    const variableBindingAtLine = (line) => {
      const use = analysis.variableUses.find(
        (candidate) => candidate.start <= line && line <= candidate.end,
      );
      return use !== undefined && bindingResolves(use.envBinding, use);
    };
    scanInstallLines({
      rel,
      text,
      canonical,
      record,
      violate,
      variableBindingAtLine,
      variableScopeAtLine: (line) => {
        const use = analysis.variableUses.find(
          (candidate) => candidate.start <= line && line <= candidate.end,
        );
        return use?.job === undefined ? "" : ` in job "${use.job}"`;
      },
    });

    for (const use of analysis.variableUses) {
      if (use.value.includes("bun.sh/install")) continue;
      const resolves = bindingResolves(use.envBinding, use);
      record({
        surface: `${kind}-shell-cache-variable`,
        file: rel,
        line: use.start,
        value: use.value,
        classification: resolves
          ? "resolvable-expression"
          : "unbound-expression",
        ...(use.job === undefined ? {} : { job: use.job }),
      });
      if (!resolves) {
        violate(
          `${rel}:${use.start}: unbound shell/cache variable \${BUN_VERSION} in job "${use.job ?? "<workflow>"}" has no effective canonical BUN_VERSION declaration in workflow/job/step scope.`,
        );
      }
    }

    // Invariant 5: a composite action's bun-version input defaults canonical.
    if (kind === "action" && analysis.compositeDefault !== null) {
      const defaultValue = analysis.compositeDefault.raw;
      record({
        surface: "composite-default",
        file: rel,
        line: analysis.compositeDefault.line,
        value: defaultValue,
        classification: defaultValue === canonical ? "canonical" : "divergent",
      });
      if (defaultValue !== canonical) {
        violate(
          `${rel}: composite bun-version input defaults to ${JSON.stringify(defaultValue)} — callers relying on the default silently float. Default must be the canonical ${canonical} (${VERSION_FILE}).`,
        );
      }
    }
  }

  // --- Invariant 3, non-Action installers: Dockerfiles, shell scripts,
  // standalone YAML runtime manifests, cloud-init templates, and .mjs
  // bootstrap installers. Workflow-shaped YAML was scanned above. ---
  for (const rel of tracked) {
    const name = basename(rel);
    const isDockerfile = name.startsWith("Dockerfile");
    const isShellLike = /\.(sh|tftpl|mjs)$/.test(rel);
    const isStandaloneYaml = /\.ya?ml$/.test(rel) && !scannedYamlFiles.has(rel);
    if (!isDockerfile && !isShellLike && !isStandaloneYaml) continue;
    const excluded = excludedSurface(rel);
    if (excluded) {
      record({
        surface: "installer",
        file: rel,
        value: null,
        classification: excluded.classification,
        reason: excluded.reason,
      });
      continue;
    }
    const text = read(rel);
    const lines = text.split("\n");
    const variableBindings = new Map();
    if (isDockerfile) {
      let globalDefault = null;
      let stageBinding = null;
      let beforeFirstFrom = true;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const arg = line.match(
          /^\s*ARG\s+BUN_VERSION(?:=["']?([^\s"']+)["']?)?\s*$/i,
        );
        if (arg) {
          const explicit = arg[1] ?? null;
          let effective = explicit;
          if (beforeFirstFrom) {
            globalDefault = explicit;
          } else if (explicit === null) {
            effective = globalDefault;
            stageBinding = globalDefault;
          } else {
            stageBinding = explicit;
          }
          const classification =
            effective === canonical
              ? explicit === null
                ? "resolvable-expression"
                : "canonical"
              : effective === null
                ? "unbound-expression"
                : "divergent";
          record({
            surface: "dockerfile-arg-default",
            file: rel,
            line: i + 1,
            value: explicit,
            classification,
          });
          if (effective !== canonical) {
            violate(
              `${rel}:${i + 1}: BUN_VERSION defaults to ${effective ?? "<unbound>"} — a Dockerfile runtime ARG must have or inherit the canonical ${canonical} default (${VERSION_FILE}).`,
            );
          }
        }
        const env = line.match(
          /^\s*ENV\s+BUN_VERSION(?:=|\s+)["']?([^\s"']+)["']?/i,
        );
        if (env) {
          stageBinding = env[1];
          record({
            surface: "dockerfile-env-default",
            file: rel,
            line: i + 1,
            value: env[1],
            classification: env[1] === canonical ? "canonical" : "divergent",
          });
          if (env[1] !== canonical) {
            violate(
              `${rel}:${i + 1}: BUN_VERSION ENV defaults to ${env[1]} — a Dockerfile runtime environment must pin the canonical ${canonical} (${VERSION_FILE}).`,
            );
          }
        }
        const from = line.match(/^\s*FROM\s+oven\/bun:([^\s]+)/i);
        if (from) {
          const tag = from[1];
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
          const viaArg = tag.includes("${BUN_VERSION}");
          // Image tags carry distro variants (1.3.14-alpine, 1.3.14-debian);
          // the version prefix is what must match the canonical pin.
          const tagVersion = tag.match(
            /^(\d+\.\d+\.\d+)(?:-[A-Za-z0-9.-]+)?$/,
          )?.[1];
          const floating = /^(canary|latest)(?:-|$)/.test(tag);
          const ok = viaArg
            ? globalDefault === canonical
            : tagVersion === canonical;
          record({
            surface: "dockerfile-base-image",
            file: rel,
            line: i + 1,
            value: tag,
            classification: viaArg
              ? ok
                ? "resolvable-expression"
                : "unbound-expression"
              : ok
                ? "canonical"
                : floating
                  ? "floating"
                  : "divergent",
          });
          if (!ok) {
            violate(
              `${rel}:${i + 1}: FROM oven/bun:${tag} — the base-image runtime must be the canonical ${canonical} (${VERSION_FILE}) (variant suffixes allowed); interpolated \${BUN_VERSION} has no earlier canonical global ARG BUN_VERSION default.`,
            );
          }
        }
        if (/^\s*FROM\s+/i.test(line)) {
          beforeFirstFrom = false;
          stageBinding = null;
        }
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile shell variable syntax, not a JS template
        if (line.includes("${BUN_VERSION}") && !arg && !env && !from) {
          const bound = stageBinding === canonical;
          variableBindings.set(i + 1, bound);
          if (!line.includes("bun.sh/install")) {
            record({
              surface: "dockerfile-shell-cache-variable",
              file: rel,
              line: i + 1,
              value: line.trim(),
              classification: bound
                ? "resolvable-expression"
                : "unbound-expression",
            });
            if (!bound) {
              violate(
                `${rel}:${i + 1}: unbound shell variable \${BUN_VERSION} has no canonical BUN_VERSION ARG/ENV in this stage.`,
              );
            }
          }
        }
      }
    } else {
      let shellBinding = false;
      for (const [i, line] of lines.entries()) {
        const def = line.match(
          /BUN_VERSION=["']?\$\{BUN_VERSION:-([^}"']+)\}["']?/,
        );
        const literal = line.match(
          /^\s*(?:export\s+|readonly\s+)?BUN_VERSION=["']?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*)["']?(?:\s+#.*)?$/,
        );
        const declared = def?.[1] ?? literal?.[1];
        if (declared !== undefined) {
          shellBinding = declared === canonical;
          record({
            surface: "shell-default",
            file: rel,
            line: i + 1,
            value: declared,
            classification: shellBinding ? "canonical" : "divergent",
          });
          if (!shellBinding) {
            violate(
              `${rel}:${i + 1}: shell BUN_VERSION default ${declared} must be the canonical ${canonical} (${VERSION_FILE}).`,
            );
          }
        }
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable syntax, not a JS template
        if (line.includes("${BUN_VERSION}") && declared === undefined) {
          variableBindings.set(i + 1, shellBinding);
          if (!line.includes("bun.sh/install")) {
            record({
              surface: "shell-cache-variable",
              file: rel,
              line: i + 1,
              value: line.trim(),
              classification: shellBinding
                ? "resolvable-expression"
                : "unbound-expression",
            });
            if (!shellBinding) {
              violate(
                `${rel}:${i + 1}: unbound shell/cache variable \${BUN_VERSION} has no earlier canonical BUN_VERSION default.`,
              );
            }
          }
        }
      }
    }
    scanInstallLines({
      rel,
      text,
      canonical,
      record,
      violate,
      variableBindingAtLine: (line) => variableBindings.get(line) === true,
      variableScopeAtLine: () => "",
      dockerfile: isDockerfile,
    });
  }

  // --- Invariant 7: gate lanes wire the canonical literal directly. Missing
  // gate files throw via the uncaught read — a required lane that vanished is
  // a contract failure, not a skip. Fixture trees create every gate. ---
  for (const name of GATE_WORKFLOWS) {
    const rel = join(WORKFLOW_DIR, name);
    const text = read(rel);
    const values = bunVersionValues(text);
    const floats = values.find(
      (v) => !isExpression(v.raw) && FLOATING.has(v.raw),
    );
    if (floats !== undefined) {
      violate(
        `${rel}: is a deterministic CI lane but wires floating Bun "${floats.raw}". It must stay pinned to ${canonical} (${VERSION_FILE}) so setup is reproducible and does not require tag discovery.`,
      );
    }
    if (!values.some((v) => v.raw === canonical)) {
      violate(
        `${rel}: is a deterministic CI lane but does not wire the canonical Bun pin ${canonical} (${VERSION_FILE}). Expected a BUN_VERSION/bun-version: "${canonical}" literal.`,
      );
    }
    if (CONTRACT_ENFORCEMENT_WORKFLOWS.has(name)) {
      if (
        !/node packages\/scripts\/ci-bun-version-contract\.mjs\s+--inventory\s+["']?\$RUNNER_TEMP\/bun-runtime-inventory\.json/.test(
          text,
        )
      ) {
        violate(
          `${rel}: required lane does not execute the Bun contract with an exact-head inventory. Run \`node packages/scripts/ci-bun-version-contract.mjs --inventory "$RUNNER_TEMP/bun-runtime-inventory.json"\`.`,
        );
      }
      if (
        !text.includes("name: bun-runtime-inventory") ||
        !text.includes(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression required in the workflow contract
          "path: ${{ runner.temp }}/bun-runtime-inventory.json",
        )
      ) {
        violate(
          `${rel}: required lane does not upload the bun-runtime-inventory artifact from the exact PR head.`,
        );
      }
    }
  }

  // --- Invariant 4: manifests and type anchors. A tracked package.json that
  // fails to parse throws: a surface that cannot be inspected must fail the
  // contract rather than silently vanish from the inventory. ---
  for (const rel of tracked) {
    if (basename(rel) !== "package.json") continue;
    let parsed;
    try {
      parsed = JSON.parse(read(rel));
    } catch (error) {
      throw new Error(
        `${rel}: tracked manifest failed to parse — cannot verify its Bun surfaces (${error.message})`,
        { cause: error },
      );
    }
    const pm = parsed.packageManager;
    if (typeof pm === "string" && pm.startsWith("bun@")) {
      const version = pm.slice("bun@".length);
      record({
        surface: "packageManager",
        file: rel,
        value: pm,
        classification: version === canonical ? "canonical" : "divergent",
      });
      if (version !== canonical) {
        violate(
          `${rel}: packageManager is ${pm}, but the canonical Bun runtime is ${canonical} (${VERSION_FILE}) — an unpublished or floating declaration 404s in any tool that resolves it.`,
        );
      }
    }
    const isRoot = rel === "package.json";
    for (const depField of ["dependencies", "devDependencies"]) {
      for (const dep of ["@types/bun", "bun-types"]) {
        const range = parsed[depField]?.[dep];
        if (typeof range !== "string") continue;
        const classification = isRoot
          ? range === canonical
            ? "exact-canonical"
            : "divergent"
          : classifyTypeRange(range, canonical);
        record({
          surface: isRoot ? "root-type-anchor" : "workspace-type-range",
          file: rel,
          value: `${dep}@${range}`,
          classification,
        });
        if (isRoot && range !== canonical) {
          violate(
            `${rel}: root type anchor ${dep} is "${range}" but must pin the canonical ${canonical} exactly — the root anchors are the repository's Bun API baseline.`,
          );
        }
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `${violations.length} Bun runtime contract violation(s):\n- ${violations.join("\n- ")}`,
    );
  }

  return {
    canonical,
    inventory,
    concretePins: inventory.filter(
      (site) =>
        site.surface === "workflow-version" &&
        site.classification === "canonical",
    ),
    gateWorkflows: GATE_WORKFLOWS,
  };
}

// Shared line scan for the two install idioms that appear outside Action
// YAML keys: `curl … bun.sh/install | bash …` and direct release-artifact
// downloads (`oven-sh/bun/releases/download/bun-v<v>/…`). The GitHub
// `releases/latest/download` convenience URL is deliberately rejected because
// it moves without a repository change. Comment lines are prose, not installs;
// a `${BUN_VERSION}` reference is accepted only when the caller proves the
// effective job, shell, or Docker stage binds it to the canonical default.
function scanInstallLines({
  rel,
  text,
  canonical,
  record,
  violate,
  variableBindingAtLine,
  variableScopeAtLine,
  dockerfile = false,
}) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    if (line.includes("bun.sh/install")) {
      const installGuard = lines
        .slice(Math.max(0, i - 4), i)
        .toReversed()
        .find((candidate) =>
          /^\s*["'`]?\s*if\s+.*command\s+-v\s+bun/.test(candidate),
        );
      if (installGuard !== undefined) {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable reference, not a JS template
        const guardUsesVariable = installGuard.includes("${BUN_VERSION}");
        const resolvesCanonicalVersion =
          installGuard.includes("bun --version") &&
          (installGuard.includes(canonical) ||
            (guardUsesVariable && variableBindingAtLine(i + 1)));
        record({
          surface: "preinstalled-runtime-guard",
          file: rel,
          line: i + 1,
          value: installGuard.trim(),
          classification: resolvesCanonicalVersion ? "canonical" : "implicit",
        });
        if (!resolvesCanonicalVersion) {
          violate(
            `${rel}:${i + 1}: Bun installation is guarded only by executable presence, so an arbitrary preinstalled Bun becomes authoritative. Compare \`bun --version\` with ${canonical} before deciding to skip the pinned install.`,
          );
        }
      }
      const pinnedLiteral = line.includes(`bun-v${canonical}`);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable reference, not a JS template
      const viaVariable = line.includes("bun-v${BUN_VERSION}");
      const variableBound = viaVariable && variableBindingAtLine(i + 1);
      const pinned = pinnedLiteral || variableBound;
      record({
        surface: "shell-install",
        file: rel,
        line: i + 1,
        value: line.trim(),
        classification: pinned
          ? viaVariable
            ? "resolvable-expression"
            : "canonical"
          : viaVariable
            ? "unbound-expression"
            : "floating",
      });
      if (!pinned) {
        if (viaVariable) {
          const scope = variableScopeAtLine(i + 1);
          const reason = dockerfile
            ? "no canonical BUN_VERSION ARG/ENV in this stage"
            : scope.length > 0
              ? "the effective workflow/job/step scope has no canonical BUN_VERSION declaration"
              : "no earlier canonical BUN_VERSION default was established";
          violate(
            `${rel}:${i + 1}: unbound shell variable \${BUN_VERSION}${scope} — ${reason}.`,
          );
        } else {
          violate(
            `${rel}:${i + 1}: bun.sh/install without the pinned release tag — a bare install or a channel argument puts a moving Bun on the host. Use \`bash -s "bun-v${canonical}"\`.`,
          );
        }
      }
    }
    if (/oven-sh\/bun\/releases\/latest\/download\//.test(line)) {
      record({
        surface: "release-download",
        file: rel,
        line: i + 1,
        value: "latest",
        classification: "floating",
      });
      violate(
        `${rel}:${i + 1}: downloads Bun from floating releases/latest — use the canonical bun-v${canonical} release URL (${VERSION_FILE}).`,
      );
      continue;
    }
    const download = line.match(
      /oven-sh\/bun\/releases\/download\/bun-v(\d+\.\d+\.\d+)/,
    );
    if (download) {
      record({
        surface: "release-download",
        file: rel,
        line: i + 1,
        value: download[1],
        classification: download[1] === canonical ? "canonical" : "divergent",
      });
      if (download[1] !== canonical) {
        violate(
          `${rel}:${i + 1}: downloads Bun release bun-v${download[1]} — must be the canonical ${canonical} (${VERSION_FILE}).`,
        );
      }
    }
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const inventoryFlag = process.argv.indexOf("--inventory");
    const { canonical, inventory, concretePins, gateWorkflows } = runContract();
    if (inventoryFlag !== -1 && process.argv[inventoryFlag + 1]) {
      writeFileSync(
        process.argv[inventoryFlag + 1],
        `${JSON.stringify({ canonical, generatedAt: new Date().toISOString(), sites: inventory }, null, 2)}\n`,
      );
    }
    const counts = {};
    for (const site of inventory) {
      counts[site.classification] = (counts[site.classification] ?? 0) + 1;
    }
    console.log(
      `ci bun version contract passed (canonical ${canonical}; ${inventory.length} sites scanned; ` +
        `${concretePins.length} workflow pin(s) in lockstep; ${gateWorkflows.length} gate lane(s) pinned; ` +
        `classifications: ${Object.entries(counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")})`,
    );
  } catch (error) {
    console.error(`[ci-bun-version-contract] FAIL ${error.message}`);
    process.exit(1);
  }
}
