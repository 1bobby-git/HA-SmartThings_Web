export type LoginSettingsProbe = {
  result: "opener" | "menu" | "on" | "off" | "missing" | "ambiguous" | "blocked" | "unknown";
  native?: boolean;
};

/** Executed in the browser. Return only enum/boolean evidence, never account
 * text, markup, storage, cookies or input values. An empty marker is READ ONLY.
 * Unknown controls, external links, device settings and Support access are not
 * clicked. Open shadow roots are inspected; closed roots are not bypassed.
 */
export function inspectLoginSettingsDom({ action, marker, target }: {
  action: "opener" | "menu" | "control"; marker: string; target: string;
}): LoginSettingsProbe {
  if (location.href !== target || location.origin !== "https://my.smartthings.com") return { result: "blocked" };
  const normalize = (text: string | null | undefined) => (text ?? "").replace(/\s+/gu, " ").trim();
  const all: Element[] = [];
  const trees: (Document | ShadowRoot)[] = [document];
  while (trees.length) {
    for (const element of trees.pop()!.querySelectorAll("*")) {
      all.push(element);
      if (all.length > 16_000) return { result: "blocked" };
      if (element.shadowRoot) trees.push(element.shadowRoot);
    }
  }
  const parentOf = (element: Element): Element | null => {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  const contains = (parent: Element, child: Element): boolean => {
    for (let node: Element | null = child; node; node = parentOf(node)) if (node === parent) return true;
    return false;
  };
  const within = (root: Element) => all.filter(element => element !== root && contains(root, element));
  const hidden = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = parentOf(node)) {
      if (node.matches('[hidden], [inert], [aria-hidden="true"]')) return true;
    }
    return false;
  };
  const visibleCache = new Map<Element, boolean>();
  const visible = (element: Element): boolean => {
    const cached = visibleCache.get(element);
    if (cached !== undefined) return cached;
    const style = getComputedStyle(element);
    const value = element.getClientRects().length > 0 && style.display !== "none" &&
      style.visibility !== "hidden" && style.visibility !== "collapse" && !hidden(element);
    visibleCache.set(element, value);
    return value;
  };
  const exact = (root: Element, pattern: RegExp) => within(root).filter(element =>
    visible(element) && pattern.test(normalize(element.textContent)) &&
    !Array.from(element.children).some(child => pattern.test(normalize(child.textContent))));
  const title = /^(?:SmartThings 설정|SmartThings settings)$/iu;
  const web = /^(?:SmartThings 웹|SmartThings web)$/iu;
  const keep = /^(?:로그인 유지|Keep me signed in|Keep signed in|Stay signed in|Keep me logged in|Stay logged in)$/iu;
  const settingsName = /^(?:SmartThings settings|SmartThings 설정|Settings|설정|Open settings|설정 열기)$/iu;
  const menuName = /^(?:SmartThings menu|SmartThings 메뉴|Menu|메뉴|Open menu|메뉴 열기|More|더보기|더 보기|More options|옵션 더보기|More actions)$/iu;
  const name = (element: Element): string => {
    const refs = element.getAttribute("aria-labelledby");
    if (refs) {
      const tree = element.getRootNode() as Document | ShadowRoot;
      return normalize(refs.split(/\s+/u).map(id => tree.getElementById(id)?.textContent ?? "").join(" "));
    }
    for (const value of [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent]) {
      if (normalize(value)) return normalize(value);
    }
    // Icon-only buttons may expose the name on their image or SVG instead.
    const names = new Set(within(element).map(child => normalize(
      child.getAttribute("aria-label") || child.getAttribute("title") || child.getAttribute("alt")
    )).filter(Boolean));
    return names.size === 1 ? [...names][0]! : "";
  };
  const controls = (root: Element): Element[] => [...new Set(within(root)
    .filter(element => element.matches('input[type="checkbox"], [role="switch"], [role="checkbox"]'))
    .map(element => within(element).find(child => child.matches('input[type="checkbox"]')) ?? element))]
    .filter(element => visible(element) || (element instanceof HTMLInputElement && !hidden(element) &&
      Array.from(element.labels ?? []).some(visible)));
  if (all.some(element => visible(element) && element.matches(
    'input[type="password"], input[autocomplete="one-time-code"], input[name="loginId"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]'
  ))) return { result: "blocked" };
  const roots = new Set<Element>();
  for (const heading of exact(document.body, title)) {
    let parent = parentOf(heading);
    for (let level = 0; parent && parent !== document.body && level < 12; level++, parent = parentOf(parent)) {
      if (exact(parent, web).length === 1 && exact(parent, keep).length === 1) { roots.add(parent); break; }
    }
  }
  if (roots.size > 1) return { result: "ambiguous" };
  const root = [...roots][0];
  const modals = all.filter(element => visible(element) && element.matches('dialog[open], [role="dialog"], [aria-modal="true"]'));
  if (modals.some(modal => !root || (!contains(modal, root) && !contains(root, modal)))) return { result: "blocked" };
  const mark = (element: Element, result: LoginSettingsProbe): LoginSettingsProbe => {
    for (let node: Element | null = element; node; node = parentOf(node)) {
      if (node.matches(':disabled, [aria-disabled="true"], [inert]')) return { result: "blocked" };
    }
    if (marker) {
      for (const prior of all) prior.removeAttribute("data-stw-login-policy");
      element.setAttribute("data-stw-login-policy", marker);
    }
    return result;
  };
  const safeLink = (element: Element): boolean => {
    if (!element.matches("a[href]")) return true;
    try {
      const url = new URL(element.getAttribute("href")!, location.href);
      return url.origin === location.origin && url.pathname === location.pathname && !url.search;
    } catch { return false; }
  };
  if (action !== "control") {
    if (root) return { result: "blocked" };
    const globalMenu = (element: Element): boolean => {
      if (/^SmartThings (?:menu|메뉴)$/iu.test(name(element))) return true;
      for (let node: Element | null = element; node; node = parentOf(node)) {
        if (node.matches('header, nav, [role="banner"], [role="navigation"]')) return true;
      }
      return false;
    };
    const matches = all.filter(element => visible(element) && safeLink(element) &&
      element.matches('button, [role="button"], [role="menuitem"], a') &&
      (action === "opener" ? settingsName.test(name(element)) : menuName.test(name(element)) && globalMenu(element)));
    return matches.length === 1 ? mark(matches[0]!, { result: action }) :
      { result: matches.length > 1 ? "ambiguous" : "missing" };
  }
  if (!root) return { result: "missing" };
  const labels = exact(root, keep);
  const matches = new Set<Element>();
  for (const control of controls(root)) {
    if (keep.test(name(control))) matches.add(control);
    if (control instanceof HTMLInputElement && Array.from(control.labels ?? []).some(label =>
      keep.test(normalize(label.textContent)) || labels.some(text => contains(label, text)))) matches.add(control);
  }
  if (matches.size === 0) for (const label of labels) {
    let row = parentOf(label);
    for (let level = 0; row && contains(root, row) && level < 6; level++, row = parentOf(row)) {
      const list = controls(row);
      if (list.length > 1) break;
      if (list.length === 1 && !exact(row, /^(?:Account data access|계정 데이터 액세스|계정 데이터 접근)$/iu).length) {
        const candidate = list[0]!;
        const explicit = candidate.getAttribute("aria-label") || candidate.getAttribute("aria-labelledby") || candidate.getAttribute("title");
        if (explicit && !keep.test(name(candidate))) break;
        matches.add(candidate); break;
      }
    }
  }
  if (matches.size !== 1) return { result: matches.size > 1 ? "ambiguous" : "missing" };
  const control = [...matches][0]!;
  if (control instanceof HTMLInputElement) return mark(control, { result: control.checked ? "on" : "off", native: true });
  const checked = control.getAttribute("aria-checked");
  if (checked !== "true" && checked !== "false") return { result: "unknown" };
  return mark(control, { result: checked === "true" ? "on" : "off", native: false });
}
