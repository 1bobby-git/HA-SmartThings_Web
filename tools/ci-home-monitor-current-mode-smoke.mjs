import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { clickCurrentHomeMonitorMode } from "../dist/bridge/src/browser/home-monitor-dom.js";

// Synthetic fixtures reproduce selector scope/identity bugs, not a captured Samsung DOM.
const monitor = ["SmartThings Home Monitor", "Home Monitor"];
const groups = [["Arm away", "Away", "보안(외출)", "외출"],
  ["Arm stay", "Stay", "보안(실내)", "실내"], ["Disarmed", "Disarm", "Off", "해제"]];
const css = '<style>section{width:420px;padding:12px}button,[role=button]{padding:12px;cursor:pointer}span{display:inline-block}</style>';
const card = (body) => `<section><h2>SmartThings Home Monitor</h2>${body}</section>`;
const native = '<button id="mode" aria-haspopup="dialog"><span>보안(외출)</span><span aria-label="보안(외출)">ⓘ</span></button>';
const browser = await chromium.launch({ headless: true,
  ...(process.env.STW_TEST_CHROMIUM ? { executablePath: process.env.STW_TEST_CHROMIUM } : {}) });
let passed = 0;
const legacy = process.argv.includes("--expect-legacy-failure");
async function run(name, html, expected, expectedClicks, currentGroup) {
  const page = await browser.newPage();
  try {
    await page.setContent(css + html);
    await page.evaluate(() => {
      window.modeClicks = [];
      document.querySelectorAll('button,[role="button"]').forEach((element) => {
        element.addEventListener("click", (event) => window.modeClicks.push({ id: element.id, trusted: event.isTrusted }));
      });
    });
    const result = await clickCurrentHomeMonitorMode(page, monitor, groups, 250, currentGroup);
    assert.equal(result, expected, name);
    assert.deepEqual(await page.evaluate(() => window.modeClicks), expectedClicks, name);
    assert.equal(await page.locator('[data-stw-hm-current-mode]').count(), 0, "temporary marker cleanup");
    console.log(`PASS ${name}`); passed++;
  } finally { await page.close(); }
}
const clicked = [{ id: "mode", trusted: true }];
try {
  const repeated = card(native) + '<section><h2>PRIVATE device</h2><button id="outside">보안(외출)</button></section>';
  if (legacy) {
    await run("baseline reproduces ambiguity for one local control and a neighbour label", repeated, "ambiguous", []);
    console.log("Baseline failure reproduced without issuing a security command");
  } else {
    await run("sibling labels resolve to one native control, not two targets", card(native), "clicked", clicked);
    await run("same-mode neighbour does not create ambiguity", repeated, "clicked", clicked);
    await run("other-mode neighbours are excluded before counting groups", card(native) + '<section><h2>PRIVATE device</h2><button id="outside">Off</button><span>실내</span></section>', "clicked", clicked);
    await run("roleless React-style current pill resolves inherited cursor to one owner", card('<div id="mode" role="button" aria-haspopup="dialog"><span>외출</span><span aria-label="외출">ⓘ</span></div>'), "clicked", clicked);
    await run("hidden ancestor alias is excluded", card('<button id="mode" aria-haspopup="dialog">외출</button><div style="opacity:0"><button>외출</button></div>'), "clicked", clicked);
    await run("disabled control is not clicked", card(native.replace('id="mode"', 'id="mode" disabled')), "not_found", []);
    await run("disabled ancestor is not bypassed", card('<div aria-disabled="true">' + native + '</div>'), "not_found", []);
    await run("two genuinely distinct controls remain ambiguous", card('<button>외출</button><button>외출</button>'), "ambiguous", []);
    await run("multiple monitor cards remain ambiguous", card(native) + card('<button>외출</button>'), "ambiguous", []);
    await run("modal blocks a dashboard opener", card(native) + '<div role="dialog">PRIVATE modal</div>', "not_found", []);
    await run("no local mode never borrows a neighbour Off control", '<div>' + card('<p>PRIVATE status</p>') + '<section><h2>PRIVATE device</h2><button id="outside">Off</button></section></div>', "not_found", []);
    await run("Disarm button is never mistaken for an armed-away picker", card('<button id="outside">해제</button>'), "not_found", [], 0);
    await run("unknown state does not click a bare Disarm action", card('<button id="outside">해제</button>'), "not_found", []);
    await run("observed roleless current mode is allowed", card('<div id="mode" role="button">외출</div>'), "clicked", clicked, 0);
    await run("substring captions are not actions", card('<button id="outside">외출 알림 설정</button>'), "not_found", []);
    await run("punctuation and whitespace aliases resolve exactly", card('<button id="mode" aria-haspopup="dialog">보안 ( 외출 )</button>'), "clicked", clicked);

    if (!process.argv.includes("--helper-only")) {
    // Exercise production orchestration, including the exact requested Stay selection.
    const { SmartThingsWebUiCommandExecutor } = await import("../dist/bridge/src/browser/command-page.js");
    const page = await browser.newPage();
    const events = [];
    try {
      await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8",
        body: '<meta charset="utf-8">' + css + repeated }));
      await page.goto("https://my.smartthings.com/location/synthetic-office");
      await page.evaluate(() => {
        window.executed = [];
        const mode = document.getElementById("mode");
        if (!mode) throw new Error("synthetic_mode_missing");
        mode.addEventListener("click", () => {
          if (document.querySelector('[role="dialog"]')) return;
          const dialog = document.createElement("div");
          dialog.setAttribute("role", "dialog");
          dialog.innerHTML = '<h2>SmartThings Home Monitor</h2><button id="away">보안(외출)</button><button id="stay">보안(실내)</button><button id="disarm">해제</button>';
          document.body.append(dialog);
          for (const button of dialog.querySelectorAll("button")) {
            button.addEventListener("click", (event) => {
              window.executed.push({ id: button.id, trusted: event.isTrusted });
              dialog.remove();
            });
          }
        });
      });
      const wrapped = new Proxy(page, { get(target, key) {
        if (key === "close") return async () => undefined;
        const value = Reflect.get(target, key);return typeof value === "function" ? value.bind(target) : value;
      } });
      const executor = new SmartThingsWebUiCommandExecutor(() => ({ openCommandPage: async () => wrapped }), (id) => id,
        { onDiagnostic: (entry) => events.push(entry) });
      const start = Date.now();
      await executor.executeLocationAction({ locationId: "synthetic-office", action: "armStay" });
      assert.deepEqual(await page.evaluate(() => window.executed), [{ id: "stay", trusted: true }], "Stay only; never an intermediate disarm");
      assert(Date.now() - start < 4_000, "already-rendered single-mode layout must not spend five seconds probing absent direct buttons");
      assert(events.includes("home_monitor_current_mode_opened"));
      console.log("PASS full Away-to-Stay selector route; no intermediate disarm; under 4s synthetic budget");passed++;
    } finally { await page.close(); }
    }
  }
  console.log(`Home Monitor scoped current-mode fixtures: ${passed} passed`);
} finally { await browser.close(); }
