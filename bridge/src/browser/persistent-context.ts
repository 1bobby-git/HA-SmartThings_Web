import { basename, isAbsolute, relative, resolve } from "node:path";

import { browserLaunchFailureToken } from "./browser-supervisor.js";

export interface PersistentContextPaths {
  dataDir: string;
  profileDir: string;
  downloadDir: string;
}

export interface PersistentContextLaunch {
  userDataDir: string;
  options: {
    headless: false;
    chromiumSandbox: boolean;
    handleSIGHUP: false;
    handleSIGINT: false;
    handleSIGTERM: false;
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

export interface PersistentContextLaunchHooks {
  onSandboxFallback?: () => void;
}

const desktopProfilePatterns = [
  /AppData[\\/]+Local[\\/]+Google[\\/]+Chrome[\\/]+User Data/i,
  /Library[\\/]+Application Support[\\/]+Google[\\/]+Chrome/i,
  /\.config[\\/]+google-chrome/i,
  /\.config[\\/]+chromium/i
];

const sandboxCompatibilityFailureTokens = new Set([
  "SANDBOX_REQUIRED",
  "SUID_SANDBOX_CONFIG",
  "SUID_SANDBOX_PERMISSION",
  "SANDBOX_PERMISSION",
  "USERNS_PERMISSION",
  "CREDENTIALS_PERMISSION",
  "ZYGOTE_PERMISSION"
]);

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
      handleSIGHUP: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      downloadsPath: normalizeBridgePath(paths.downloadDir),
      timeout: 30_000,
      viewport: { width: 1440, height: 1000 },
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--profile-directory=Default",
        "--password-store=basic",
        "--restore-last-session",
        "--disk-cache-dir=/tmp/smartthings-web-chromium-cache",
        "--disk-cache-size=67108864",
        "--media-cache-size=33554432",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--hide-crash-restore-bubble",
        "--disable-session-crashed-bubble",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding"
      ]
    }
  };
}

function normalizeBridgePath(path: string): string {
  return path.startsWith("/") ? path : resolve(path);
}

export async function launchSmartThingsPersistentContext(
  chromium: ChromiumLauncher,
  paths: PersistentContextPaths,
  hooks: PersistentContextLaunchHooks = {}
): Promise<unknown> {
  const launch = createPersistentContextLaunch(paths);
  try {
    return await chromium.launchPersistentContext(launch.userDataDir, launch.options);
  } catch (error: unknown) {
    if (!isSandboxCompatibilityFailure(error)) {
      throw error;
    }
    hooks.onSandboxFallback?.();
    return await chromium.launchPersistentContext(launch.userDataDir, {
      ...launch.options,
      chromiumSandbox: false
    });
  }
}

function isSandboxCompatibilityFailure(error: unknown): boolean {
  const token = browserLaunchFailureToken(error);
  if (sandboxCompatibilityFailureTokens.has(token)) {
    return true;
  }
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "";
  return /no usable sandbox|running as root without --no-sandbox|suid sandbox helper binary was found|failed to move to new namespace|operation not permitted[^\n]*(?:namespace|sandbox)|zygote_host_impl_linux/iu.test(
    message
  );
}
