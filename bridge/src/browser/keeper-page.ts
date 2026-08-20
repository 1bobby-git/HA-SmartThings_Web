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
  #keeper: BrowserPageLike | undefined;

  constructor(private readonly context: BrowserContextLike) {}

  async ensureKeeper(): Promise<BrowserPageLike> {
    const candidates = this.context
      .pages()
      .filter((page) => !page.isClosed() && isKeeperCandidateUrl(page.url()));
    const loginPage = this.context
      .pages()
      .find((page) => !page.isClosed() && isSamsungLoginUrl(page.url()));

    const keeper =
      this.#keeper && !this.#keeper.isClosed()
        ? this.#keeper
        : candidates[0] ?? loginPage ?? this.findReusableBlankPage() ?? (await this.createKeeperPage());
    this.#keeper = keeper;

    for (const duplicate of candidates.filter((candidate) => candidate !== keeper)) {
      await duplicate.close();
    }

    if (keeper.url() !== KEEPER_URL && !isSamsungLoginUrl(keeper.url())) {
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

  private findReusableBlankPage(): BrowserPageLike | undefined {
    return this.context.pages().find((page) => !page.isClosed() && page.url() === "about:blank");
  }
}

function isKeeperCandidateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://my.smartthings.com" && url.pathname === "/location";
  } catch {
    return false;
  }
}

function isSamsungLoginUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "account.samsung.com";
  } catch {
    return false;
  }
}
