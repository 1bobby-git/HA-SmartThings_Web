import { type BrowserContextLike, type BrowserPageLike, type KeeperPageManager } from "./keeper-page.js";

export function isProbeBrowserIsolated(
  context: BrowserContextLike | undefined,
  keeperManager: KeeperPageManager | undefined
): boolean {
  if (!context || !keeperManager) {
    return false;
  }

  const keeper = keeperManager.currentKeeper();
  if (!keeper || keeper.isClosed()) {
    return false;
  }

  const openPages = context.pages().filter((page) => !page.isClosed());
  return openPages.length === 1 && openPages[0] === keeper && isSettledKeeperLocation(keeper);
}

function isSettledKeeperLocation(page: BrowserPageLike): boolean {
  try {
    const url = new URL(page.url());
    return (
      url.origin === "https://my.smartthings.com" &&
      /^\/location(?:\/[^/]+)?\/?$/.test(url.pathname) &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
