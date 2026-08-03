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
 * Checked statically against the checked-in tree (no workflow is executed):
 *
 *   1. Every `bun-version:`/`BUN_VERSION:` value in workflows and composite
 *      actions is the canonical pin, a resolvable expression whose declaration
 *      in the same file is canonical, or an explicitly allowlisted floating
 *      cell. Concrete divergence, floating values, unbound expressions, and
 *      unparseable syntax all fail.
 *   2. Every `oven-sh/setup-bun` use is pinned to a reviewed commit SHA and
 *      wires an explicit `bun-version` — the action's implicit default is
 *      `latest`, so an absent key is a floating runtime.
 *   3. Every `bun.sh/install` shell install pins `bun-v<canonical>` — a bare
 *      `| bash` or a channel argument installs a moving runtime on deploy
 *      hosts.
 *   4. Every `packageManager` declaring Bun (root, Feed, generated-project
 *      template, and anything added later) equals `bun@<canonical>`, and the
 *      root `@types/bun`/`bun-types` anchors equal the canonical version
 *      exactly. Non-root workspace type declarations are classified in the
 *      inventory (exact-canonical / compatible-range / drift / unparseable)
 *      but stay advisory: they are compatibility signals, not runtime
 *      selectors (#17044 scope).
 *   5. A composite action declaring a `bun-version` input must default it to
 *      the canonical pin, since callers relying on the default otherwise
 *      float silently — the previous `canary` default covered 112 call sites.
 *   6. Deterministic gate and deploy workflows (GATE_WORKFLOWS) additionally
 *      must wire the canonical literal directly, so required checks never
 *      depend on indirection to become reproducible.
 *
 * The full scan is returned (and writable via --inventory) as a
 * machine-readable inventory of every resolution site and its classification.
 * Embedded platform Bun binaries (Android/RISC-V artifacts) are a separate
 * shipping boundary and are deliberately not scanned here.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
// that runs IN ADDITION to the pinned lane. Each entry scopes one file plus
// the exact floating value it may wire, with a reason. Empty by design: no
// workflow currently has a sanctioned reason to float, and an entry added
// here is a reviewable diff rather than silent drift.
const FLOATING_ALLOWLIST = [];

// Required, scheduled, and deploy-critical install lanes that must wire the
// concrete pin directly (not merely resolve through indirection). The required
// `ci-ok` aggregate (test.yml), main gate (ci.yaml), and canonical cloud
// deploy are the load-bearing paths.
const GATE_WORKFLOWS = [
  "ci.yaml",
  "test.yml",
  "cloud-cf-deploy.yml",
  "app-aesthetic-audit.yml",
  "develop-exhaustive.yml",
  "ci-full-matrix-proof.yml",
  "benchmark-tests.yml",
  "windows-desktop-preload-smoke.yml",
  "feed-env-audit.yml",
];

// A concrete pin: a plain semver, optionally with a prerelease/build suffix.
// `canary`, `latest`, and `${{ ... }}` expressions deliberately do not match.
const CONCRETE_PIN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;
const FLOATING = new Set(["canary", "latest"]);

// Directories that never contain first-party manifests; skipping them keeps
// the package.json walk fast and out of vendored trees.
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
// `{ key, raw, line }`, with inline comments and quotes stripped. Handles the
// scalar form, the flow list (`bun-version: ["1.3.14"]`, matrix cells), and
// the block list (`bun-version:` followed by `- value` items). Only real YAML
// key wiring counts — a version named in a `#` comment is never a pin.
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
        });
      }
      continue;
    }
    if (raw.startsWith("[")) {
      // Flow list: split the bracketed cells.
      const inner = raw.replace(/^\[/, "").replace(/\]$/, "");
      for (const cell of inner.split(",")) {
        const value = stripQuotes(cell.trim());
        if (value) out.push({ key, raw: value, line: i + 1 });
      }
      continue;
    }
    out.push({ key, raw: stripQuotes(raw), line: i + 1 });
  }
  return out;
}

function isExpression(raw) {
  return raw.includes("${{");
}

// Expressions that resolve within the same file: `${{ env.BUN_VERSION }}`
// resolves against the file's own BUN_VERSION declaration and
// `${{ matrix.bun-version }}` against its matrix cells — both of which this
// contract validates independently, so the indirection cannot hide a float.
// Inside composite actions, `${{ inputs.bun-version }}` resolves against the
// input default validated by the composite rule. Anything else is unbound.
const RESOLVABLE_EXPRESSIONS = {
  workflow: [
    /^\$\{\{\s*env\.BUN_VERSION\s*\}\}$/,
    /^\$\{\{\s*matrix\.bun-version\s*\}\}$/,
  ],
  action: [
    /^\$\{\{\s*inputs\.bun-version\s*\}\}$/,
    /^\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+\s*\}\}$/,
  ],
};

function isAllowlisted(allowlist, file, value) {
  return allowlist.some(
    (entry) => entry.file === file && entry.value === value,
  );
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

function walkPackageJsons(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (entry.name === "package.json") {
        found.push(join(dir, entry.name));
      }
    }
  }
  return found.sort();
}

function tryRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Validate every invariant against a repo layout rooted at `repoRoot`. Pure
// (no process exit / no console) so tests can drive it against fixture trees.
// Collects every violation before throwing one aggregate error, so a version
// bump sees the complete list of stale sites in a single run. Returns the
// canonical version and the full classified inventory on success.
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

  // --- YAML surfaces: workflows and composite actions. ---
  const yamlFiles = [];
  try {
    for (const name of readdirSync(resolve(repoRoot, WORKFLOW_DIR))) {
      if (name.endsWith(".yml") || name.endsWith(".yaml")) {
        yamlFiles.push({ rel: join(WORKFLOW_DIR, name), kind: "workflow" });
      }
    }
  } catch {
    // Fixture trees without workflows still exercise the manifest rules.
  }
  try {
    for (const name of readdirSync(resolve(repoRoot, ACTIONS_DIR))) {
      for (const candidate of ["action.yml", "action.yaml"]) {
        const rel = join(ACTIONS_DIR, name, candidate);
        try {
          statSync(resolve(repoRoot, rel));
          yamlFiles.push({ rel, kind: "action" });
        } catch {
          // Only one of the two spellings exists per action.
        }
      }
    }
  } catch {
    // No composite actions in this tree.
  }

  for (const { rel, kind } of yamlFiles) {
    const text = read(rel);
    const lines = text.split("\n");

    // Invariant 1: every wired value is canonical, resolvable, or allowlisted.
    for (const { key, raw, line } of bunVersionValues(text)) {
      const site = {
        surface: `${kind}-version`,
        file: rel,
        line,
        key,
        value: raw,
      };
      if (isExpression(raw)) {
        const ok = RESOLVABLE_EXPRESSIONS[kind].some((re) => re.test(raw));
        record({
          ...site,
          classification: ok ? "resolvable-expression" : "unbound-expression",
        });
        if (!ok) {
          violate(
            `${rel}:${line}: wires Bun via unbound expression ${raw} — only same-file env.BUN_VERSION / matrix.bun-version indirection is checkable, so this cannot be proven pinned.`,
          );
        }
        continue;
      }
      if (FLOATING.has(raw)) {
        const ok = isAllowlisted(allowlist, rel, raw);
        record({
          ...site,
          classification: ok ? "allowlisted-floating" : "floating",
        });
        if (!ok) {
          violate(
            `${rel}:${line}: wires floating Bun "${raw}". Every authoritative lane must stay pinned to ${canonical} (${VERSION_FILE}); a deliberate extra compatibility cell needs a FLOATING_ALLOWLIST entry.`,
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

    // Invariant 2: setup-bun refs are reviewed SHAs and never implicit.
    for (let i = 0; i < lines.length; i++) {
      const use = lines[i].match(
        /^(\s*)(?:-\s+)?uses:\s*["']?oven-sh\/setup-bun@([^\s"']+)["']?/,
      );
      if (!use) continue;
      const ref = use[2];
      const refSite = {
        surface: "setup-bun-ref",
        file: rel,
        line: i + 1,
        value: ref,
      };
      if (!reviewedShas.has(ref)) {
        record({ ...refSite, classification: "unreviewed-ref" });
        violate(
          `${rel}:${i + 1}: oven-sh/setup-bun@${ref} is not pinned to a reviewed commit SHA — mutable tags can repoint. Pin one of: ${[...reviewedShas].join(", ")}.`,
        );
      } else {
        record({ ...refSite, classification: "reviewed-sha" });
      }

      // Locate the step block around this `uses` and require an explicit
      // bun-version inside it: setup-bun's own default is floating `latest`.
      const stepIndent = use[1].length;
      let start = i;
      for (let j = i; j >= 0; j--) {
        const dash = lines[j].match(/^(\s*)-\s/);
        if (dash && dash[1].length <= stepIndent) {
          start = j;
          break;
        }
      }
      let end = lines.length;
      const startIndent = (lines[start].match(/^(\s*)/) ?? ["", ""])[1].length;
      for (let j = start + 1; j < lines.length; j++) {
        const dash = lines[j].match(/^(\s*)-\s/);
        const dedent = lines[j].match(/^(\s*)\S/);
        if (
          (dash && dash[1].length <= startIndent) ||
          (dedent && dedent[1].length < startIndent)
        ) {
          end = j;
          break;
        }
      }
      const step = lines.slice(start, end).join("\n");
      if (!/^\s*bun-version:/m.test(step)) {
        record({
          surface: "setup-bun-version",
          file: rel,
          line: i + 1,
          value: null,
          classification: "implicit",
        });
        violate(
          `${rel}:${i + 1}: oven-sh/setup-bun use wires no bun-version — the action's implicit default is floating "latest". Pin ${canonical} (${VERSION_FILE}).`,
        );
      }
    }

    // Invariant 3: shell installs pin the canonical release tag.
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("bun.sh/install")) continue;
      if (/^\s*#/.test(lines[i])) continue;
      const pinned = lines[i].includes(`bun-v${canonical}`);
      record({
        surface: "shell-install",
        file: rel,
        line: i + 1,
        value: lines[i].trim(),
        classification: pinned ? "canonical" : "floating",
      });
      if (!pinned) {
        violate(
          `${rel}:${i + 1}: bun.sh/install without the pinned release tag — a bare install or a channel argument puts a moving Bun on the host. Use \`bash -s "bun-v${canonical}"\`.`,
        );
      }
    }

    // Invariant 5: a composite action's bun-version input defaults canonical.
    if (kind === "action") {
      const inputIdx = lines.findIndex((l) => /^ {2}bun-version:\s*$/.test(l));
      if (inputIdx !== -1) {
        let defaultValue = null;
        for (let j = inputIdx + 1; j < lines.length; j++) {
          if (/^ {2}\S/.test(lines[j])) break;
          const def = lines[j].match(/^\s+default:\s*(.+?)\s*$/);
          if (def) {
            defaultValue = stripQuotes(def[1].replace(/\s+#.*$/, "").trim());
            break;
          }
        }
        record({
          surface: "composite-default",
          file: rel,
          value: defaultValue,
          classification:
            defaultValue === canonical ? "canonical" : "divergent",
        });
        if (defaultValue !== canonical) {
          violate(
            `${rel}: composite bun-version input defaults to ${JSON.stringify(defaultValue)} — callers relying on the default silently float. Default must be the canonical ${canonical} (${VERSION_FILE}).`,
          );
        }
      }
    }
  }

  // --- Invariant 6: gate lanes wire the canonical literal directly. ---
  for (const name of GATE_WORKFLOWS) {
    const rel = join(WORKFLOW_DIR, name);
    const text = tryRead(resolve(repoRoot, rel));
    if (text === null) continue;
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
  }

  // --- Invariant 4: manifests and type anchors. ---
  const rootPackagePath = resolve(repoRoot, "package.json");
  const rootPackageText = tryRead(rootPackagePath);
  for (const path of walkPackageJsons(repoRoot)) {
    const rel = relative(repoRoot, path).split(sep).join("/");
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // Malformed manifests are some other gate's problem.
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
    const isRoot = resolve(path) === rootPackagePath;
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
  if (rootPackageText === null && overrides.requireRootPackage) {
    violate(
      `package.json: missing — cannot verify the packageManager surface.`,
    );
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
