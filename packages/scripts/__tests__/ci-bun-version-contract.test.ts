/**
 * Pins the Bun runtime contract (#13402, #17044) against synthetic repo trees
 * and the real checkout. A clean tree passes (with `canary` named only in a
 * comment ignored), and each failure mode the contract exists to catch is
 * exercised red: divergent concrete pin, floating literal/env/matrix cell,
 * mutable action tag, implicit setup-bun, expressions whose backing
 * declaration is missing (env, matrix, and composite step-output forms),
 * unpinned bun.sh/install, Dockerfile ARG/FROM drift, divergent release
 * downloads, drifting packageManager and root type anchors, floating
 * composite-action defaults, allowlist entries that lack a reason or a
 * canonical sibling lane, a malformed tracked manifest, and a missing gate
 * workflow (fail-fast, not skip). Deterministic — no workflow runs, no
 * network.
 */
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
  origin?: string;
  value: string | null;
  classification: string;
  reason?: string;
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
  overrides?: Record<string, string | null>;
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
    // `null` deletes a gate: the contract must fail loudly on a missing
    // required lane rather than skip it.
    if (overrides[name] === null) continue;
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

function expectViolation(
  root: string,
  pattern: RegExp,
  overrides?: Record<string, unknown>,
) {
  try {
    expect(() => runContract(root, overrides)).toThrow(pattern);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function inventoryOf(
  root: string,
  overrides?: Record<string, unknown>,
): InventorySite[] {
  try {
    return runContract(root, overrides).inventory;
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

  test("fails loudly when a gate workflow is missing, instead of skipping", () => {
    expectViolation(buildRepo({ overrides: { "ci.yaml": null } }), /ci\.yaml/);
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

  test("fails an env expression whose BUN_VERSION declaration is missing", () => {
    const unbacked = `name: Lane
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ env.BUN_VERSION }}
`;
    expectViolation(
      buildRepo({ extra: { "unbacked-env.yml": unbacked } }),
      /unbound expression.*no BUN_VERSION declaration/,
    );
  });

  test("fails a matrix expression with no bun-version cells to resolve", () => {
    const unbacked = `name: Lane
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ matrix.bun-version }}
`;
    expectViolation(
      buildRepo({ extra: { "unbacked-matrix.yml": unbacked } }),
      /unbound expression.*no bun-version matrix cells/,
    );
  });

  test("fails a step-output expression that cannot be proven pinned", () => {
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

  test("fails a composite action wiring a step-output instead of its input", () => {
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
        bun-version: \${{ steps.resolve.outputs.version }}
`;
    expectViolation(
      buildRepo({ files: { ".github/actions/setup/action.yml": action } }),
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

  test("scans shell scripts outside workflows as install surfaces", () => {
    expectViolation(
      buildRepo({
        files: {
          "deploy/install.sh": "curl -fsSL https://bun.sh/install | bash\n",
        },
      }),
      /deploy\/install\.sh:1: bun\.sh\/install without the pinned release tag/,
    );
  });

  test("fails a Dockerfile whose BUN_VERSION default floats", () => {
    expectViolation(
      buildRepo({
        files: {
          "services/runner/Dockerfile": [
            "FROM node:24-slim",
            "ARG BUN_VERSION=canary",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
            'RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"',
            "",
          ].join("\n"),
        },
      }),
      /BUN_VERSION defaults to canary/,
    );
  });

  test("fails a floating oven/bun base image and passes canonical variants", () => {
    expectViolation(
      buildRepo({ files: { "sim/Dockerfile": "FROM oven/bun:canary\n" } }),
      /FROM oven\/bun:canary/,
    );
    const inventory = inventoryOf(
      buildRepo({
        files: {
          "sim/Dockerfile": `FROM oven/bun:${CANONICAL}-alpine\n`,
          "runner/Dockerfile": [
            "FROM node:24-slim",
            `ARG BUN_VERSION=${CANONICAL}`,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
            'RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"',
            "",
          ].join("\n"),
        },
      }),
    );
    const image = inventory.find((s) => s.surface === "dockerfile-base-image");
    expect(image?.classification).toBe("canonical");
    const install = inventory.find(
      (s) => s.surface === "shell-install" && s.file === "runner/Dockerfile",
    );
    expect(install?.classification).toBe("canonical");
  });

  test("fails a divergent oven-sh release download URL", () => {
    expectViolation(
      buildRepo({
        files: {
          "infra/bootstrap.yaml.tftpl":
            "  - su - deploy -c 'curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.3.13/bun-linux-x64.zip'\n",
        },
      }),
      /downloads Bun release bun-v1\.3\.13/,
    );
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

  test("fails loudly on a malformed tracked manifest instead of skipping it", () => {
    expectViolation(
      buildRepo({ files: { "packages/bad/package.json": "{ not json" } }),
      /packages\/bad\/package\.json: tracked manifest failed to parse/,
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
    const inventory = inventoryOf(
      buildRepo({
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
      }),
    );
    const ranges = inventory.filter(
      (s) => s.surface === "workspace-type-range",
    );
    expect(
      ranges.find((s) => s.file.includes("packages/a"))?.classification,
    ).toBe("compatible-range");
    expect(
      ranges.find((s) => s.file.includes("packages/b"))?.classification,
    ).toBe("drift");
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
    const inventory = inventoryOf(
      buildRepo({ files: { ".github/actions/setup/action.yml": action } }),
    );
    const site = inventory.find((s) => s.surface === "composite-default");
    expect(site?.classification).toBe("canonical");
  });

  test("rejects an allowlist entry with no reason", () => {
    expectViolation(
      buildRepo({ extra: { "compat.yml": gateStub() } }),
      /has no reason/,
      {
        floatingAllowlist: [
          { file: ".github/workflows/compat.yml", value: "canary", reason: "" },
        ],
      },
    );
  });

  test("rejects an allowlisted canary that is the file's only runtime", () => {
    const canaryOnly = `name: Compat
on: [push]
jobs:
  canary-cell:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: canary
`;
    expectViolation(
      buildRepo({ extra: { "compat.yml": canaryOnly } }),
      /must run in addition to the canonical/,
      {
        floatingAllowlist: [
          {
            file: ".github/workflows/compat.yml",
            value: "canary",
            reason: "upstream compatibility cell (test)",
          },
        ],
      },
    );
  });

  test("permits an allowlisted floating cell beside a canonical lane", () => {
    const additive = `name: Compat
on: [push]
env:
  BUN_VERSION: "${CANONICAL}"
jobs:
  pinned:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ env.BUN_VERSION }}
  canary-cell:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: canary
`;
    const inventory = inventoryOf(
      buildRepo({ extra: { "compat.yml": additive } }),
      {
        floatingAllowlist: [
          {
            file: ".github/workflows/compat.yml",
            value: "canary",
            reason: "upstream compatibility cell (test)",
          },
        ],
      },
    );
    const site = inventory.find(
      (s) => s.file === ".github/workflows/compat.yml" && s.value === "canary",
    );
    expect(site?.classification).toBe("allowlisted-floating");
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
    // would mean the tracked-file enumeration or a reader silently broke.
    for (const surface of [
      "workflow-version",
      "setup-bun-ref",
      "shell-install",
      "release-download",
      "dockerfile-arg-default",
      "dockerfile-base-image",
      "packageManager",
      "root-type-anchor",
      "workspace-type-range",
      "composite-default",
    ]) {
      expect(inventory.some((s) => s.surface === surface)).toBe(true);
    }
    // The scoped-out boundaries are inventoried as exclusions, never silent.
    expect(
      inventory.some((s) => s.classification === "embedded-boundary-excluded"),
    ).toBe(true);
    expect(
      inventory.filter((s) => s.classification === "floating").length,
    ).toBe(0);
    expect(
      inventory.filter((s) => s.classification === "unreviewed-ref").length,
    ).toBe(0);
    expect(
      inventory.filter((s) => s.classification === "unbound-expression").length,
    ).toBe(0);
  });
});
