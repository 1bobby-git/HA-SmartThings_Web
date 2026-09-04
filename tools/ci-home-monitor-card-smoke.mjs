import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { clickHomeMonitorCardAction } from "../dist/bridge/src/browser/home-monitor-card.js";

// Synthetic, screenshot-informed fixtures, not a captured Samsung DOM or a live account test.
const groups = [["Arm away", "Away", "보안(외출)", "외출"],
  ["Arm stay", "Stay", "보안(실내)", "재실"], ["Disarmed", "Disarm", "해제"]];
const monitor = ["SmartThings Home Monitor", "홈 모니터"];
const browser = await chromium.launch({ headless: true,
  ...(process.env.STW_TEST_CHROMIUM ? { executablePath: process.env.STW_TEST_CHROMIUM } : {}) });
let passed = 0;
const css = '<style>section{width:420px;padding:12px}button,[role=button]{padding:12px}svg{width:400px;height:160px}g.mode{cursor:pointer}svg text{font:16px sans-serif}</style>';
const htmlCard = (contents) => `<section><h2>SmartThings Home Monitor</h2>${contents}</section>`;
const svgCard = `<section><h2>SmartThings Home Monitor</h2><svg viewBox="0 0 400 160">
  <text x="12" y="24">System ready to arm</text>
  <g class="mode" id="stay"><rect x="10" y="90" width="180" height="40"/><text x="32" y="118" fill="white">보안(실내)</text></g>
  <g class="mode" id="away"><rect x="205" y="90" width="180" height="40"/><text x="230" y="118" fill="white">보안(외출)</text></g>
  </svg></section>`;
const capture = `<script>window.actions=[];for(const id of ['away','stay','outside']){const el=document.getElementById(id);if(el)el.addEventListener('click',e=>window.actions.push({id,trusted:e.isTrusted}))}</script>`;
async function run(name, html, group, expected, check) {
  const page = await browser.newPage();
  const diagnostics = [];
  try {
    await page.setContent(css + html + capture);
    const result = await clickHomeMonitorCardAction(page, monitor, groups, group, 150,
      (item) => diagnostics.push(item));
    assert.equal(result, expected, name);
    await check?.(page, diagnostics);
    assert.equal(await page.locator('[data-stw-hm-card-action]').count(), 0);
    assert.doesNotMatch(JSON.stringify(diagnostics), /SmartThings|PRIVATE|secret|customer|보안/u);
    passed++;
    console.log(`PASS ${name}`);
  } finally { await page.close(); }
}
const one = (id) => async (page) => assert.deepEqual(await page.evaluate(() => window.actions), [{ id, trusted: true }]);
const none = async (page) => assert.deepEqual(await page.evaluate(() => window.actions), []);
try {
  await run("dashboard HTML selects away without opening a dialog", htmlCard('<button id="stay">보안(실내)</button><button id="away">보안(외출)</button>'), 0, "clicked", one("away"));
  await run("dashboard SVG selects away with trusted pointer", svgCard, 0, "clicked", async (page, diag) => {
    await one("away")(page);
    assert.equal(diag.at(-1).svgModes, 2);
  });
  await run("dashboard SVG selects stay", svgCard, 1, "clicked", one("stay"));
  await run("SVG tspan and parenthesis whitespace", svgCard.replace('보안(외출)', '<tspan>보안 </tspan><tspan>( 외출 )</tspan>'), 0, "clicked", one("away"));
  await run("HTML fragmented labels with description", htmlCard('<button id="stay">보안(실내)</button><button id="away"><span>보안</span><b>( 외출 )</b><p>PRIVATE explanation</p></button>'), 0, "clicked", one("away"));
  await run("CSS literal mode label", htmlCard('<button id="stay">보안(실내)</button><button id="away" class="generated"></button><style>.generated:after{content:"보안(외출)"}</style>'), 0, "clicked", one("away"));
  await run("aria-labelledby external text", htmlCard('<span id="name" hidden>보안(외출)</span><button id="away" aria-labelledby="name">PRIVATE</button><button id="stay">보안(실내)</button>'), 0, "clicked", one("away"));
  await run("disabled control is not clicked", htmlCard('<button disabled id="away">보안(외출)</button><button id="stay">보안(실내)</button>'), 0, "blocked", none);
  await run("disabled ancestor is not bypassed", htmlCard('<div aria-disabled="true"><button id="away">보안(외출)</button></div><button id="stay">보안(실내)</button>'), 0, "blocked", none);
  await run("duplicate exact actions fail closed", htmlCard('<button id="away">보안(외출)</button><button>보안(외출)</button><button id="stay">보안(실내)</button>'), 0, "ambiguous", none);
  await run("modal blocks dashboard action", svgCard + '<div role="dialog">PRIVATE unknown modal</div>', 0, "dialog", none);
  await run("unrelated card is not monitor scope", '<div>' + htmlCard('<span>해제</span>') + '<section><h2>PRIVATE device</h2><button id="away">외출</button><button id="stay">재실</button></section></div>', 0, "not_found", none);
  await run("unknown label is not matched by substring", htmlCard('<button id="away">외출 알림 설정</button><button id="stay">보안(실내)</button>'), 0, "not_found", none);
  await run("shared clickable container is ambiguous", htmlCard('<button id="away"><span>보안(외출)</span><span>보안(실내)</span></button>'), 0, "blocked", none);
  await run("single current mode stays on original path", htmlCard('<button id="stay">해제</button>'), 0, "not_found", none);
  await run("canvas is diagnosed, not guessed by coordinate", htmlCard('<canvas width="100" height="50"></canvas>'), 0, "not_found", async (page, diag) => {
    await none(page);
    assert.equal(diag.at(-1).canvases, 1);
  });
  await run("multiple monitor cards are ambiguous", svgCard + htmlCard('<button>외출</button><button>재실</button>'), 0, "ambiguous", none);
  await run("open shadow root SVG controls", '<div id="host"></div><script>host.attachShadow({mode:"open"}).innerHTML=' + JSON.stringify(css + svgCard) + ';window.shadowActions=[];host.shadowRoot.getElementById("away").onclick=e=>window.shadowActions.push(e.isTrusted)</script>', 0, "clicked", async(page)=>assert.deepEqual(await page.evaluate(()=>window.shadowActions),[true]));

  // Verify the actual production orchestration using intercepted local HTML only.
  const { SmartThingsWebUiCommandExecutor } = await import("../dist/bridge/src/browser/command-page.js");
  const { clickTextOnlyHomeMonitorAction } = await import("../dist/bridge/src/browser/home-monitor-dom.js");
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: css + svgCard + capture }));
    await page.goto("https://my.smartthings.com/location/test-office");
    // This fixture reproduces the HTMLElement-only omission in the old dashboard helper.
    assert.equal(await clickTextOnlyHomeMonitorAction(page, monitor, groups[0], groups, 100), "not_found");
    await none(page);
    const diagnostics = [];
    const wrapped = new Proxy(page, { get(target, property) {
      if (property === "close") return async () => undefined;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const executor = new SmartThingsWebUiCommandExecutor(
      () => ({ openCommandPage: async () => wrapped }), (id) => id,
      { onHomeMonitorCardDiagnostic: (entry) => diagnostics.push(entry) }
    );
    await executor.executeLocationAction({ locationId: "test-office", action: "armAway" });
    await one("away")(page);
    assert.equal(diagnostics.at(-1).outcome, "clicked");
    passed++;
    console.log("PASS full command-page SVG dashboard route (old helper regression reproduced)");
  } finally { await page.close(); }
  console.log(`Home Monitor real-browser card fixtures: ${passed} passed`);
} finally { await browser.close(); }
