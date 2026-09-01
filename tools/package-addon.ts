import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageSource {
  sourcePath: string;
  relativePath: string;
}

export interface PackageAddonOptions {
  repoRoot: string;
  outputRoot: string;
  beforeCopy?: (source: PackageSource) => Promise<void> | void;
}

export interface PackageAddonResult {
  packageDir: string;
  files: string[];
  manifestSha256: string;
}

interface SourceFile {
  sourcePath: string;
  relativePath: string;
  realPath: string;
  identity: SourceIdentity;
}

interface SourceIdentity {
  dev: string;
  ino: string;
  mode: string;
  size: string;
  mtimeMs: string;
  ctimeMs: string;
}

interface Manifest {
  schema_version: 1;
  files: Array<{ path: string; sha256: string }>;
}

const ADDON_NAME = "smartthings_web_bridge";
const MANIFEST_NAME = "addon-package-manifest.json";
const ROOT_FILES = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json"];
const ROOT_TREES = ["bridge/src", `addon/${ADDON_NAME}`];
const ROOT_TOOL_FILES = [
  "tools/haos-soak.ts",
  "tools/haos-soak-core.ts",
  "tools/haos-soak-resume-core.ts",
  "tools/haos-soak-deployment-gate-core.ts",
  "tools/haos-live-control-event-benchmark.ts",
  "tools/haos-live-control-event-benchmark-core.ts",
  "tools/smartthings-web-parity-audit.ts",
  "tools/smartthings-web-parity-audit-core.ts",
];
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const EXCLUDED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "tests",
  "fixtures",
  "dist",
  "secrets",
  "profiles",
  "runtime",
]);

const toManifestPath = (path: string) => path.split(sep).join("/");

const comparePath = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const isWithin = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const pathsOverlap = (left: string, right: string) => isWithin(left, right) || isWithin(right, left);

const normalizeDestinationKey = (path: string) => {
  const normalized = toManifestPath(path);
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
};

const identityFromStats = (stats: Awaited<ReturnType<typeof lstat>>): SourceIdentity => ({
  dev: String(stats.dev),
  ino: String(stats.ino),
  mode: String(stats.mode),
  size: String(stats.size),
  mtimeMs: String(stats.mtimeMs),
  ctimeMs: String(stats.ctimeMs),
});

const sameIdentity = (left: SourceIdentity, right: SourceIdentity) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const shouldExclude = (relativePath: string) => {
  const normalized = toManifestPath(relativePath);
  const fileName = normalized.split("/").at(-1) ?? "";
  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return true;
  }

  return normalized.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
};

const assertRegularSource = async (path: string, label: string) => {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new Error(`Missing required source: ${label}`);
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to package symlink or reparse point: ${label}`);
  }

  if (!stats.isFile() && !stats.isDirectory()) {
    throw new Error(`Refusing to package non-regular source: ${label}`);
  }

  return stats;
};

const lstatOrUndefined = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

const sourceFileFromStats = async (
  sourcePath: string,
  relativePath: string,
  stats: Awaited<ReturnType<typeof lstat>>,
): Promise<SourceFile> => ({
  sourcePath,
  relativePath: toManifestPath(relativePath),
  realPath: await realpath(sourcePath),
  identity: identityFromStats(stats),
});

const collectTree = async (repoRoot: string, relativeRoot: string, packageRoot = relativeRoot): Promise<SourceFile[]> => {
  const rootPath = join(repoRoot, relativeRoot);
  const rootStats = await assertRegularSource(rootPath, relativeRoot);
  if (!rootStats.isDirectory()) {
    throw new Error(`Required source is not a directory: ${relativeRoot}`);
  }

  const files: SourceFile[] = [];
  const visit = async (sourcePath: string, relativePath: string, packagePath: string) => {
    const stats = await assertRegularSource(sourcePath, relativePath);
    if (shouldExclude(relativePath)) {
      return;
    }

    if (stats.isDirectory()) {
      const entries = await readdir(sourcePath);
      for (const entry of entries.sort(comparePath)) {
        await visit(join(sourcePath, entry), join(relativePath, entry), join(packagePath, entry));
      }
      return;
    }

    if (stats.isFile()) {
      files.push(await sourceFileFromStats(sourcePath, packagePath, stats));
    }
  };

  await visit(rootPath, relativeRoot, packageRoot);
  return files;
};

const collectSources = async (repoRoot: string) => {
  const files: SourceFile[] = [];

  for (const relativePath of ROOT_FILES) {
    const sourcePath = join(repoRoot, relativePath);
    const stats = await assertRegularSource(sourcePath, relativePath);
    if (!stats.isFile()) {
      throw new Error(`Required source is not a file: ${relativePath}`);
    }
    files.push(await sourceFileFromStats(sourcePath, relativePath, stats));
  }

  for (const relativePath of ROOT_TOOL_FILES) {
    const sourcePath = join(repoRoot, relativePath);
    const stats = await assertRegularSource(sourcePath, relativePath);
    if (!stats.isFile()) {
      throw new Error(`Required source is not a file: ${relativePath}`);
    }
    files.push(await sourceFileFromStats(sourcePath, relativePath, stats));
  }

  files.push(...(await collectTree(repoRoot, "bridge/src")));
  files.push(...(await collectTree(repoRoot, `addon/${ADDON_NAME}`, "")));

  return files.sort((a, b) => comparePath(a.relativePath, b.relativePath));
};

const assertNoDestinationCollisions = (sources: SourceFile[]) => {
  const seen = new Map<string, SourceFile>();
  for (const source of sources) {
    const key = normalizeDestinationKey(source.relativePath);
    const existing = seen.get(key);
    if (existing) {
      throw new Error(
        `Package destination collision: ${source.relativePath} from ${source.sourcePath} conflicts with ${existing.sourcePath}`,
      );
    }
    seen.set(key, source);
  }
};

const sha256File = async (path: string) =>
  new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });

const sha256Text = (text: string) => createHash("sha256").update(text).digest("hex");

const assertNoDestinationSourceOverlap = (packageDir: string, sourcePaths: string[]) => {
  for (const sourcePath of sourcePaths) {
    const resolvedSource = resolve(sourcePath);
    if (pathsOverlap(packageDir, resolvedSource)) {
      throw new Error(`Package destination overlaps source path: ${resolvedSource}`);
    }
  }
};

const assertDirectoryIsNotReparsePoint = async (path: string, label: string) => {
  const stats = await lstatOrUndefined(path);
  if (!stats) {
    await mkdir(path, { recursive: true });
    const createdStats = await lstat(path);
    if (!createdStats.isDirectory()) {
      throw new Error(`${label} is not a directory: ${path}`);
    }
    return;
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink, junction, or reparse point: ${path}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
};

const canonicalPackageDir = async (outputRoot: string) => {
  await assertDirectoryIsNotReparsePoint(outputRoot, "Package output root");
  const canonicalOutputRoot = await realpath(outputRoot);
  const packageDir = resolve(outputRoot, ADDON_NAME);
  const packageStats = await lstatOrUndefined(packageDir);
  if (packageStats?.isSymbolicLink()) {
    throw new Error(`Package destination must not be a symlink, junction, or reparse point: ${packageDir}`);
  }
  if (packageStats && !packageStats.isDirectory()) {
    throw new Error(`Package destination is not a directory: ${packageDir}`);
  }

  return {
    outputRoot,
    canonicalOutputRoot,
    packageDir,
    canonicalPackageDir: packageStats ? await realpath(packageDir) : resolve(canonicalOutputRoot, ADDON_NAME),
  };
};

const copyStableSource = async (source: SourceFile, destinationPath: string) => {
  const handle = await open(source.sourcePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Refusing to package non-regular source: ${source.relativePath}`);
    }

    const currentRealPath = await realpath(source.sourcePath);
    if (currentRealPath !== source.realPath || !sameIdentity(source.identity, identityFromStats(stats))) {
      throw new Error(`Source changed before copy: ${source.relativePath}`);
    }

    const sourceBytes = await handle.readFile();
    await writeFile(destinationPath, canonicalPackageBytes(source.relativePath, sourceBytes));
  } finally {
    await handle.close();
  }
};

const canonicalPackageBytes = (relativePath: string, sourceBytes: Buffer): Buffer => {
  if (!isPackageTextPath(relativePath)) {
    return sourceBytes;
  }
  let text: string;
  try {
    text = UTF8_DECODER.decode(sourceBytes);
  } catch {
    throw new Error(`Package text source is not valid UTF-8: ${relativePath}`);
  }
  return Buffer.from(text.replace(/\r\n?/gu, "\n"), "utf8");
};

const isPackageTextPath = (relativePath: string) =>
  ROOT_FILES.includes(relativePath) ||
  ROOT_TOOL_FILES.includes(relativePath) ||
  relativePath.startsWith("bridge/src/") ||
  relativePath.startsWith("rootfs/") ||
  relativePath === "CHANGELOG.md" ||
  relativePath === "DOCS.md" ||
  relativePath === "Dockerfile" ||
  relativePath === "README.md" ||
  relativePath === "apparmor.txt" ||
  relativePath === "config.yaml";

const removePath = async (path: string) => {
  await rm(path, { recursive: true, force: true });
};

const replacePackageDir = async (stagingDir: string, packageDir: string) => {
  const existingStats = await lstatOrUndefined(packageDir);
  if (!existingStats) {
    await rename(stagingDir, packageDir);
    return;
  }

  if (existingStats.isSymbolicLink()) {
    throw new Error(`Package destination must not be a symlink, junction, or reparse point: ${packageDir}`);
  }

  const backupDir = join(dirname(packageDir), `.${ADDON_NAME}-backup-${crypto.randomUUID()}`);
  await rename(packageDir, backupDir);
  try {
    await rename(stagingDir, packageDir);
  } catch (error) {
    try {
      await rename(backupDir, packageDir);
    } catch {
      // Preserve the original failure while making a best effort to restore the previous package.
    }
    throw error;
  }

  await removePath(backupDir);
};

export async function packageAddon(options: PackageAddonOptions): Promise<PackageAddonResult> {
  const repoRoot = resolve(options.repoRoot);
  const outputRoot = resolve(options.outputRoot);
  const paths = await canonicalPackageDir(outputRoot);
  const packageDir = paths.packageDir;

  if (!isWithin(outputRoot, packageDir)) {
    throw new Error(`Package destination must stay under output root: ${packageDir}`);
  }

  const sources = await collectSources(repoRoot);
  assertNoDestinationCollisions(sources);
  assertNoDestinationSourceOverlap(paths.canonicalPackageDir, [
    ...ROOT_FILES.map((sourcePath) => join(repoRoot, sourcePath)),
    ...ROOT_TOOL_FILES.map((sourcePath) => join(repoRoot, sourcePath)),
    ...ROOT_TREES.map((sourcePath) => join(repoRoot, sourcePath)),
    ...sources.map((source) => source.sourcePath),
    ...sources.map((source) => source.realPath),
  ]);

  const stagingDir = await mkdtemp(join(paths.canonicalOutputRoot, `.${ADDON_NAME}-staging-`));

  try {
    for (const source of sources) {
      await options.beforeCopy?.({ sourcePath: source.sourcePath, relativePath: source.relativePath });
      const destinationPath = resolve(stagingDir, ...source.relativePath.split("/"));
      if (!isWithin(stagingDir, destinationPath)) {
        throw new Error(`Package file destination escapes package directory: ${source.relativePath}`);
      }
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyStableSource(source, destinationPath);
    }

    const manifest: Manifest = {
      schema_version: 1,
      files: [],
    };

    for (const source of sources) {
      manifest.files.push({
        path: source.relativePath,
        sha256: await sha256File(join(stagingDir, ...source.relativePath.split("/"))),
      });
    }

    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestPath = join(stagingDir, MANIFEST_NAME);
    await writeFile(manifestPath, manifestText);

    await replacePackageDir(stagingDir, packageDir);

    return {
      packageDir,
      files: manifest.files.map((entry) => entry.path),
      manifestSha256: sha256Text(manifestText),
    };
  } catch (error) {
    await removePath(stagingDir);
    throw error;
  }
}

const runCli = async () => {
  const repoRoot = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  const outputRoot = process.argv[3] ? resolve(process.argv[3]) : resolve(repoRoot, "dist-addon");
  const result = await packageAddon({ repoRoot, outputRoot });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
