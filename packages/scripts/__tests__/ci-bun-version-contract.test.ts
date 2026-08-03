// Pins the Bun runtime contract (#13402, #17044) against synthetic repo trees:
// a clean tree passes (with `canary` named only in a comment ignored), while
// each failure mode the contract exists to catch is exercised red — divergent
// concrete pin, floating literal/env/matrix cell, mutable action tag, implicit
// setup-bun, unbound expression, unpinned bun.sh/install, drifting
// packageManager, drifting root type anchor, and a floating composite-action
// default. Also runs the shipped contract against the real repo so the guard
// stays true as workflows change. Deterministic — no workflow runs.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { runContract, classifyTypeRange } = await import(
  new URL("../ci-bun-version-contract.mjs", import.meta.url).href
);

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

interface InventorySite {
  surface: string;
  file: string;
  line?: number;
  key?: string;
  value: string | null;
  classification: string;
}

const CANONICAL = "1.3.14";
const SHA = "0c5077e51419868618aeaa5fe8019c62421857d6";

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

// A gate stub that pins via a BUN_VERSION env literal and references it from
// the step by expression — the shape the real gates use. The comment naming
// `canary` proves the contract reads YAML wiring, not prose.
function gateStub(version = CANONICAL): string {
  return `name: Gate
on: [push]
env:
  # pinned: floating canary writes lockfileVersion 2 and breaks --frozen-lockfile
  BUN_VERSION: "${version}"
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: ./.github/actions/setup-bun-workspace
        with:
          bun-version: \${{ env.BUN_VERSION }}
`;
}

function pinnedWorkflow(version = CANONICAL, ref = SHA): string {
  return `name: Lane
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${ref}
        with:
          bun-version: "${version}"
`;
}

const GATE_FLOATING = `name: Gate
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: canary
`;

const GATE_NO_PIN = `name: Gate
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "no bun setup here"
`;

function buildRepo({
  version = CANONICAL,
  overrides = {},
  extra = {},
  files = {},
}: {
  version?: string;
  overrides?: Record<string, string>;
  extra?: Record<string, string>;
  files?: Record<string, string>;
}): string {
  const root = mkdtempSync(join(tmpdir(), "ci-bun-version-contract-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "ci-bun-version.json"),
    JSON.stringify({ version }),
  );
  for (const name of GATE_WORKFLOWS) {
    writeFileSync(
      join(root, ".github", "workflows", name),
      overrides[name] ?? gateStub(),
    );
  }
  for (const [name, content] of Object.entries(extra)) {
    writeFileSync(join(root, ".github", "workflows", name), content);
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function expectViolation(root: string, pattern: RegExp) {
  try {
    expect(() => runContract(root)).toThrow(pattern);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("ci-bun-version-contract", () => {
  test("passes a clean tree with every gate pinned to canonical", () => {
    const root = buildRepo({});
    try {
      const { canonical, gateWorkflows } = runContract(root);
      expect(canonical).toBe(CANONICAL);
      expect(gateWorkflows).toEqual(GATE_WORKFLOWS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when a concrete pin diverges from the source of truth", () => {
    expectViolation(
      buildRepo({ extra: { "drift.yml": pinnedWorkflow("1.3.99") } }),
      /canonical CI Bun version is 1\.3\.14/,
    );
  });

  test("fails when a gate workflow floats back to canary", () => {
    expectViolation(
      buildRepo({ overrides: { "test.yml": GATE_FLOATING } }),
      /wires floating Bun/,
    );
  });

  test("fails when a gate workflow drops the canonical pin entirely", () => {
    expectViolation(
      buildRepo({ overrides: { "ci.yaml": GATE_NO_PIN } }),
      /does not wire the canonical Bun pin/,
    );
  });

  test("fails when the source of truth itself floats", () => {
    const root = buildRepo({ version: "canary" });
    try {
      expect(() => runContract(root)).toThrow(/must be a concrete Bun pin/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails a mutable setup-bun tag even when the version is canonical", () => {
    expectViolation(
      buildRepo({ extra: { "mutable.yml": pinnedWorkflow(CANONICAL, "v2") } }),
      /not pinned to a reviewed commit SHA/,
    );
  });

  test("fails an implicit setup-bun use (no bun-version wired)", () => {
    const implicit = `name: Lane
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
      - run: bun install
`;
    expectViolation(
      buildRepo({ extra: { "implicit.yml": implicit } }),
      /wires no bun-version/,
    );
  });

  test("fails a floating matrix cell in flow-list form", () => {
    const matrix = `name: Lane
on: [push]
jobs:
  build:
    strategy:
      matrix:
        bun-version: ["canary"]
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ matrix.bun-version }}
`;
    expectViolation(
      buildRepo({ extra: { "matrix.yml": matrix } }),
      /wires floating Bun/,
    );
  });

  test("fails a floating matrix cell in block-list form", () => {
    const matrix = `name: Lane
on: [push]
jobs:
  build:
    strategy:
      matrix:
        bun-version:
          - canary
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ matrix.bun-version }}
`;
    expectViolation(
      buildRepo({ extra: { "matrix-block.yml": matrix } }),
      /wires floating Bun/,
    );
  });

  test("fails an unbound expression that cannot be proven pinned", () => {
    const unbound = `name: Lane
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ steps.resolver.outputs.version }}
`;
    expectViolation(
      buildRepo({ extra: { "unbound.yml": unbound } }),
      /unbound expression/,
    );
  });

  test("fails a bun.sh/install without the pinned release tag", () => {
    const shell = `name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-24.04
    steps:
      - run: |
          curl -fsSL https://bun.sh/install | bash -s "canary"
`;
    expectViolation(
      buildRepo({ extra: { "shell.yml": shell } }),
      /bun\.sh\/install without the pinned release tag/,
    );
  });

  test("passes a bun.sh/install pinned to the canonical release tag", () => {
    const shell = `name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-24.04
    steps:
      - run: |
          curl -fsSL https://bun.sh/install | bash -s "bun-v${CANONICAL}"
`;
    const root = buildRepo({ extra: { "shell.yml": shell } });
    try {
      const inventory: InventorySite[] = runContract(root).inventory;
      const site = inventory.find((s) => s.surface === "shell-install");
      expect(site.classification).toBe("canonical");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails a packageManager declaring a non-canonical Bun", () => {
    expectViolation(
      buildRepo({
        files: {
          "package.json": JSON.stringify({ packageManager: "bun@1.4.0" }),
        },
      }),
      /packageManager is bun@1\.4\.0/,
    );
  });

  test("fails a root type anchor that is not the exact canonical version", () => {
    expectViolation(
      buildRepo({
        files: {
          "package.json": JSON.stringify({
            packageManager: `bun@${CANONICAL}`,
            devDependencies: { "@types/bun": "^1.3.12" },
          }),
        },
      }),
      /root type anchor/,
    );
  });

  test("classifies workspace type ranges without failing the contract", () => {
    const root = buildRepo({
      files: {
        "package.json": JSON.stringify({
          packageManager: `bun@${CANONICAL}`,
          devDependencies: { "bun-types": CANONICAL },
        }),
        "packages/a/package.json": JSON.stringify({
          devDependencies: { "bun-types": "^1.2.0" },
        }),
        "packages/b/package.json": JSON.stringify({
          devDependencies: { "bun-types": "1.3.13" },
        }),
      },
    });
    try {
      const inventory: InventorySite[] = runContract(root).inventory;
      const ranges = inventory.filter(
        (s) => s.surface === "workspace-type-range",
      );
      expect(
        ranges.find((s) => s.file.includes("packages/a")).classification,
      ).toBe("compatible-range");
      expect(
        ranges.find((s) => s.file.includes("packages/b")).classification,
      ).toBe("drift");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails a composite action whose bun-version input defaults floating", () => {
    const action = `name: Setup
inputs:
  bun-version:
    description: "Bun version"
    required: false
    default: "canary"
runs:
  using: composite
  steps:
    - uses: oven-sh/setup-bun@${SHA}
      with:
        bun-version: \${{ inputs.bun-version }}
`;
    expectViolation(
      buildRepo({ files: { ".github/actions/setup/action.yml": action } }),
      /composite bun-version input defaults/,
    );
  });

  test("passes a composite action defaulting to the canonical pin", () => {
    const action = `name: Setup
inputs:
  bun-version:
    description: "Bun version"
    required: false
    default: "${CANONICAL}"
runs:
  using: composite
  steps:
    - uses: oven-sh/setup-bun@${SHA}
      with:
        bun-version: \${{ inputs.bun-version }}
`;
    const root = buildRepo({
      files: { ".github/actions/setup/action.yml": action },
    });
    try {
      const inventory: InventorySite[] = runContract(root).inventory;
      const site = inventory.find((s) => s.surface === "composite-default");
      expect(site.classification).toBe("canonical");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an explicit allowlist entry permits a deliberate floating cell", () => {
    const floating = `name: Compat
on: [push]
jobs:
  canary-cell:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: canary
`;
    const root = buildRepo({ extra: { "compat.yml": floating } });
    try {
      const inventory: InventorySite[] = runContract(root, {
        floatingAllowlist: [
          {
            file: ".github/workflows/compat.yml",
            value: "canary",
            reason: "upstream compatibility cell (test)",
          },
        ],
      }).inventory;
      const site = inventory.find(
        (s) =>
          s.file === ".github/workflows/compat.yml" && s.value === "canary",
      );
      expect(site.classification).toBe("allowlisted-floating");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifyTypeRange models the syntaxes this repo uses", () => {
    expect(classifyTypeRange(CANONICAL, CANONICAL)).toBe("exact-canonical");
    expect(classifyTypeRange("*", CANONICAL)).toBe("compatible-range");
    expect(classifyTypeRange("^1.2.25", CANONICAL)).toBe("compatible-range");
    expect(classifyTypeRange("~1.3.2", CANONICAL)).toBe("compatible-range");
    expect(classifyTypeRange("~1.2.0", CANONICAL)).toBe("drift");
    expect(classifyTypeRange("1.3.13", CANONICAL)).toBe("drift");
    expect(classifyTypeRange("^2.0.0", CANONICAL)).toBe("drift");
    expect(classifyTypeRange("workspace:*", CANONICAL)).toBe("unparseable");
  });

  test("the real repo satisfies the contract", () => {
    const result = runContract(REAL_REPO_ROOT);
    const canonical: string = result.canonical;
    const inventory: InventorySite[] = result.inventory;
    const gateWorkflows: string[] = result.gateWorkflows;
    expect(canonical).toBe(CANONICAL);
    expect(gateWorkflows.length).toBeGreaterThan(0);
    // The repo genuinely has every surface the contract models; an empty scan
    // would mean the walker or the YAML readers silently broke.
    for (const surface of [
      "workflow-version",
      "setup-bun-ref",
      "shell-install",
      "packageManager",
      "root-type-anchor",
      "workspace-type-range",
      "composite-default",
    ]) {
      expect(inventory.some((s) => s.surface === surface)).toBe(true);
    }
    expect(
      inventory.filter((s) => s.classification === "floating").length,
    ).toBe(0);
    expect(
      inventory.filter((s) => s.classification === "unreviewed-ref").length,
    ).toBe(0);
  });
});
