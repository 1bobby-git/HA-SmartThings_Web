import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { packageAddon } from "../tools/package-addon.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const temporaryRoots: string[] = [];

interface PngMetadata {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

const readPngMetadata = async (path: string): Promise<PngMetadata> => {
  const bytes = await readFile(path);
  expect(bytes.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24] ?? 0,
    colorType: bytes[25] ?? 0,
  };
};

const expectTransparentSquarePng = async (path: string, size: number) => {
  const bytes = await readFile(path);
  const metadata = await readPngMetadata(path);

  expect(metadata).toEqual({
    width: size,
    height: size,
    bitDepth: 8,
    colorType: 6,
  });
  expect(bytes.length).toBeGreaterThan(1_000);
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SmartThings brand assets", () => {
  test("provides the square 128px Home Assistant add-on icon", async () => {
    await expectTransparentSquarePng("addon/smartthings_web_bridge/icon.png", 128);
  });

  test("provides standard and high-density integration icons", async () => {
    await expectTransparentSquarePng("custom_components/smartthings_web/brand/icon.png", 256);
    await expectTransparentSquarePng("custom_components/smartthings_web/brand/icon@2x.png", 512);
  });

  test("includes the add-on icon unchanged in the generated package", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "smartthings-brand-package-"));
    temporaryRoots.push(outputRoot);

    const result = await packageAddon({ repoRoot: resolve("."), outputRoot });
    const source = await readFile("addon/smartthings_web_bridge/icon.png");
    const packaged = await readFile(join(result.packageDir, "icon.png"));

    expect(result.files).toContain("icon.png");
    expect(packaged).toEqual(source);
  });
});
