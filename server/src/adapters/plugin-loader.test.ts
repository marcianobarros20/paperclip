import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterLoginCapability } from "@paperclipai/adapter-utils";
import {
  addAdapterPlugin,
  getAdapterPluginByType,
  removeAdapterPlugin,
} from "../services/adapter-plugin-store.js";
import {
  isReloadDirEntry,
  loadExternalAdapterPackage,
  reloadExternalAdapter,
  validateAdapterModule,
} from "./plugin-loader.js";

// A minimal external adapter module. The loader calls `createServerAdapter()`
// and then validates the returned module. Each test controls the returned
// `loginCapability` to check the fail-closed rule at load time.
function makeModule(loginCapability?: unknown) {
  return {
    createServerAdapter: () => ({
      type: "vendor_local",
      execute: async () => ({}),
      testEnvironment: async () => ({}),
      ...(loginCapability === undefined ? {} : { loginCapability }),
    }),
  };
}

const validLoginCapability: AdapterLoginCapability = {
  panelMode: "displayed_code",
  timeoutPolicy: "caller_bounded",
  getCommand: () => "vendor login",
  parsePrompt: () => null,
};

describe("validateAdapterModule login capability", () => {
  it("loads an adapter with no login capability", () => {
    expect(() => validateAdapterModule(makeModule(), "vendor-pkg")).not.toThrow();
  });

  it("loads an adapter with a well-formed login capability", () => {
    expect(() => validateAdapterModule(makeModule(validLoginCapability), "vendor-pkg")).not.toThrow();
  });

  it("rejects an adapter with a malformed login capability", () => {
    const bad = { ...validLoginCapability, panelMode: "hidden_code" };
    expect(() => validateAdapterModule(makeModule(bad), "vendor-pkg")).toThrow(
      /invalid login capability/,
    );
  });

  it("rejects an adapter with a non-object login capability", () => {
    expect(() => validateAdapterModule(makeModule("displayed_code"), "vendor-pkg")).toThrow(
      /invalid login capability/,
    );
  });
});

describe("reloadExternalAdapter nested freshness", () => {
  const prevHome = process.env.PAPERCLIP_HOME;
  let home = "";
  let pkgDir = "";

  async function writeNested(value: string): Promise<void> {
    await fs.writeFile(path.join(pkgDir, "dist", "nested.js"), `export const NESTED_VALUE = "${value}";\n`);
  }

  function markerOf(mod: unknown): unknown {
    return (mod as Record<string, unknown>).marker;
  }

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reload-fixture-"));
    process.env.PAPERCLIP_HOME = home;
    pkgDir = path.join(home, "adapter-plugins", "node_modules", "@test", "reload-fixture");
    await fs.mkdir(path.join(pkgDir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@test/reload-fixture", version: "1.0.0", exports: { ".": "./dist/index.js" } }),
    );
    await fs.writeFile(
      path.join(pkgDir, "dist", "index.js"),
      'import { NESTED_VALUE } from "./nested.js";\n' +
        'import { NESTED_VALUE as LINKED_VALUE } from "./linked.js";\n' +
        "export function createServerAdapter() {\n" +
        '  return { type: "reload_fixture_nested", execute: async () => ({}), testEnvironment: async () => ({}), marker: `${NESTED_VALUE}+${LINKED_VALUE}` };\n' +
        "}\n",
    );
    await writeNested("v1");
    await fs.symlink("./nested.js", path.join(pkgDir, "dist", "linked.js"), "file");
    addAdapterPlugin({
      packageName: "@test/reload-fixture",
      version: "1.0.0",
      type: "reload_fixture_nested",
      installedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    removeAdapterPlugin("reload_fixture_nested");
    if (prevHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = prevHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("serves fresh nested modules after the package changes on disk", async () => {
    const first = await loadExternalAdapterPackage("@test/reload-fixture");
    expect(markerOf(first)).toBe("v1+v1");

    await writeNested("v2");
    const reloaded = await reloadExternalAdapter("reload_fixture_nested");
    expect(reloaded).not.toBeNull();
    expect(markerOf(reloaded)).toBe("v2+v2");
  });

  it("retains at most two reload generations per adapter", async () => {
    const pluginsDir = path.join(home, "adapter-plugins");
    const reloadDirs = async () =>
      (await fs.readdir(pluginsDir)).filter((name) => isReloadDirEntry(name, "reload_fixture_nested"));

    await writeNested("v2");
    await reloadExternalAdapter("reload_fixture_nested");
    expect(await reloadDirs()).toHaveLength(1);

    await writeNested("v3");
    const reloaded = await reloadExternalAdapter("reload_fixture_nested");
    expect(markerOf(reloaded)).toBe("v3+v3");
    expect(await reloadDirs()).toHaveLength(2);

    await writeNested("v4");
    await reloadExternalAdapter("reload_fixture_nested");
    expect(await reloadDirs()).toHaveLength(2);
  });

  it("never matches a sibling type with a longer name", () => {
    const siblingDir = ".reload-reload_fixture_nested_extra-1759360000000-123e4567-e89b-12d3-a456-426614174000";
    const ownDir = ".reload-reload_fixture_nested-1759360000000-123e4567-e89b-12d3-a456-426614174000";
    expect(isReloadDirEntry(siblingDir, "reload_fixture_nested")).toBe(false);
    expect(isReloadDirEntry(ownDir, "reload_fixture_nested")).toBe(true);
    expect(isReloadDirEntry("node_modules", "reload_fixture_nested")).toBe(false);
  });

  it("serializes concurrent reloads of the same adapter", async () => {
    await writeNested("v2");
    const [first, second] = await Promise.all([
      reloadExternalAdapter("reload_fixture_nested"),
      reloadExternalAdapter("reload_fixture_nested"),
    ]);
    expect(markerOf(first)).toBe("v2+v2");
    expect(markerOf(second)).toBe("v2+v2");

    const pluginsDir = path.join(home, "adapter-plugins");
    const entries = await fs.readdir(pluginsDir);
    expect(entries.filter((name) => isReloadDirEntry(name, "reload_fixture_nested")).length).toBeLessThanOrEqual(2);
  });

  it("throws on staging failure, keeping the record and leaking no copy", async () => {
    await fs.rm(pkgDir, { recursive: true, force: true });
    await expect(reloadExternalAdapter("reload_fixture_nested")).rejects.toThrow(/Failed to stage reload copy/);
    expect(getAdapterPluginByType("reload_fixture_nested")).toBeDefined();

    const pluginsDir = path.join(home, "adapter-plugins");
    const entries = await fs.readdir(pluginsDir);
    expect(entries.filter((name) => isReloadDirEntry(name, "reload_fixture_nested"))).toHaveLength(0);
  });

  it("returns null only when no plugin record exists", async () => {
    removeAdapterPlugin("reload_fixture_nested");
    const reloaded = await reloadExternalAdapter("reload_fixture_nested");
    expect(reloaded).toBeNull();
  });
});
