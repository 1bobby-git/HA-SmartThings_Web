export const KEEPER_URL = "https://my.smartthings.com/location";
export const ADVANCED_URL = "https://my.smartthings.com/advanced";

export interface BrowserPageLike {
  url(): string;
  isClosed(): boolean;
  goto(url: string, options?: { waitUntil?: "domcontentloaded" | "load" }): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface BrowserContextLike {
  pages(): BrowserPageLike[];
  newPage(): Promise<BrowserPageLike>;
}

export class KeeperPageManager {
  constructor(private readonly context: BrowserContextLike) {}

  async ensureKeeper(): Promise<BrowserPageLike> {
    const candidates = this.context
      .pages()
      .filter((page) => !page.isClosed() && isKeeperUrl(page.url()));

    const keeper = candidates[0] ?? (await this.createKeeperPage());
    for (const duplicate of candidates.slice(1)) {
      await duplicate.close();
    }

    if (!isKeeperUrl(keeper.url())) {
      await keeper.goto(KEEPER_URL, { waitUntil: "domcontentloaded" });
    }

    return keeper;
  }

  async recoverKeeper(): Promise<BrowserPageLike> {
    const keeper = await this.ensureKeeper();
    await keeper.goto(KEEPER_URL, { waitUntil: "domcontentloaded" });
    return keeper;
  }

  async openAdvancedPage(): Promise<BrowserPageLike> {
    const page = await this.context.newPage();
    await page.goto(ADVANCED_URL, { waitUntil: "domcontentloaded" });
    return page;
  }

  private async createKeeperPage(): Promise<BrowserPageLike> {
    const page = await this.context.newPage();
    await page.goto(KEEPER_URL, { waitUntil: "domcontentloaded" });
    return page;
  }
}

function isKeeperUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://my.smartthings.com" && url.pathname === "/location";
  } catch {
    return false;
  }
}
