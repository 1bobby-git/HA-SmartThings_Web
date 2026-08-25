import { basename, isAbsolute, relative, resolve } from "node:path";

export interface PersistentContextPaths {
  dataDir: string;
  profileDir: string;
  downloadDir: string;
}

export interface PersistentContextLaunch {
  userDataDir: string;
  options: {
    headless: false;
    chromiumSandbox: true;
    downloadsPath: string;
    timeout: number;
    viewport: { width: number; height: number };
    args: string[];
  };
}

export interface ChromiumLauncher {
  launchPersistentContext: (
    userDataDir: string,
    options: PersistentContextLaunch["options"]
  ) => Promise<unknown>;
}

const desktopProfilePatterns = [
  /AppData[\\/]+Local[\\/]+Google[\\/]+Chrome[\\/]+User Data/i,
  /Library[\\/]+Application Support[\\/]+Google[\\/]+Chrome/i,
  /\.config[\\/]+google-chrome/i,
  /\.config[\\/]+chromium/i
];

export function validateDedicatedProfileDir(profileDir: string, dataDir?: string): void {
  const resolvedProfileDir = normalizeBridgePath(profileDir);
  const normalized = resolvedProfileDir.replaceAll("\\", "/");
  if (desktopProfilePatterns.some((pattern) => pattern.test(normalized))) {
    throw new Error("SmartThings Web Bridge requires a dedicated Chromium profile directory");
  }
  if (basename(resolvedProfileDir) !== "chromium-profile") {
    throw new Error("SmartThings Web Bridge requires a dedicated Chromium profile directory");
  }
  if (normalized.toLowerCase().includes("/desktop/") || normalized.toLowerCase().includes("/backup/")) {
    throw new Error("SmartThings Web Bridge requires a dedicated Chromium profile directory");
  }

  if (dataDir !== undefined) {
    const resolvedDataDir = normalizeBridgePath(dataDir);
    const profileRelativeToData = relative(resolvedDataDir, resolvedProfileDir);
    if (
      profileRelativeToData !== "chromium-profile" ||
      profileRelativeToData.startsWith("..") ||
      isAbsolute(profileRelativeToData)
    ) {
      throw new Error("SmartThings Web Bridge requires a dedicated Chromium profile directory");
    }
  }
}

export function createPersistentContextLaunch(paths: PersistentContextPaths): PersistentContextLaunch {
  validateDedicatedProfileDir(paths.profileDir, paths.dataDir);

  return {
    userDataDir: normalizeBridgePath(paths.profileDir),
    options: {
      headless: false,
      chromiumSandbox: true,
      downloadsPath: normalizeBridgePath(paths.downloadDir),
      timeout: 30_000,
      viewport: { width: 1440, height: 1000 },
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--restore-last-session",
        "--hide-crash-restore-bubble"
      ]
    }
  };
}

function normalizeBridgePath(path: string): string {
  return path.startsWith("/") ? path : resolve(path);
}

export async function launchSmartThingsPersistentContext(
  chromium: ChromiumLauncher,
  paths: PersistentContextPaths
): Promise<unknown> {
  const launch = createPersistentContextLaunch(paths);
  return chromium.launchPersistentContext(launch.userDataDir, launch.options);
}
