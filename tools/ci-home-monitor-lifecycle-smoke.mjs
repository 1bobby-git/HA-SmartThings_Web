import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { SmartThingsWebUiCommandExecutor } from "../dist/bridge/src/browser/command-page.js";

// Synthetic local HTML only. No live account, remote command, or mocked page.close().
const browser = await chromium.launch({ headless: true,
  ...(process.env.STW_TEST_CHROMIUM ? { executablePath: process.env.STW_TEST_CHROMIUM } : {}) });
const baseline = process.argv.includes("--baseline");
let passed = 0;
const labels = { armAway: "보안(외출)", armStay: "보안(실내)", disarm: "해제" };
const style = '<meta charset="utf-8"><style>section{width:420px;padding:12px}button{padding:12px;margin:8px}dialog{padding:24px}svg{width:420px;height:150px}svg text{font:16px sans-serif}g{cursor:pointer}</style>';
function fixture(action, kind) {
  const targetLabel = labels[action];
  const buttons = Object.entries(labels).map(([key, label]) => `<button id="${key}">${label}</button>`).join("");
  const svg = `<svg viewBox="0 0 420 150"><g id="armStay"><rect x="0" y="20" width="195" height="50"/><text x="12" y="50" fill="white">보안(실내)</text></g><g id="armAway"><rect x="210" y="20" width="195" height="50"/><text x="225" y="50" fill="white">보안(외출)</text></g></svg>`;
  const modalTitle = kind === "unrelated" ? "Unrelated device" : "SmartThings Home Monitor";
  const modalMode = kind === "wrong-mode" ? labels.armStay : targetLabel;
  const body = `<section><h2>SmartThings Home Monitor</h2><h3>System ready to arm</h3>${kind === "svg" ? svg : buttons}</section><dialog id="confirmDialog"><h2>${modalTitle}</h2><p>${modalMode}</p><button id="apply" ${kind === "disabled" ? "disabled" : ""}>확인</button>${kind === "duplicate" ? '<button id="second">확인</button>' : ""}<button id="cancel">취소</button></dialog>`;
  return style + body + `<script>
    const action = ${JSON.stringify(action)};
    const kind = ${JSON.stringify(kind)};
    const publish = () => window.__securityObserved(action);
    document.getElementById(action).addEventListener('click', event => {
      window.__record('action', event.isTrusted);
      if (['confirm','unrelated','wrong-mode','disabled','duplicate'].includes(kind)) {
        setTimeout(() => document.getElementById('confirmDialog').showModal(), 120);
      } else if (kind !== 'no-state') {
        setTimeout(publish, kind === 'fast' ? 0 : 500);
      }
    });
    for (const id of ['apply','second']) {
      document.getElementById(id)?.addEventListener('click', event => {
        window.__record('submit', event.isTrusted);
        document.getElementById('confirmDialog').close();
        setTimeout(publish, 250);
      });
    }
    document.getElementById('cancel').onclick = () => window.__record('cancel', true);
    </script>`;
}
async function run(name, action, kind, expected = "confirmed") {
  const page = await browser.newPage();
  const records = [];
  const diagnostics = [];
  let observed = false;
  let waitStarted = false;
  let resolveConfirmation;
  const confirmation = new Promise((resolve) => { resolveConfirmation = resolve; });
  await page.exposeFunction("__record", (stage, trusted) => records.push({ stage, trusted }));
  await page.exposeFunction("__securityObserved", (received) => {
    assert.equal(received, action);
    observed = true;
    records.push({ stage: "observed" });
    resolveConfirmation();
  });
  page.on("close", () => records.push({ stage: "closed" }));
  try {
    await page.route("**/*", (route) => route.fulfill({ status: 200,
      contentType: "text/html; charset=utf-8", body: fixture(action, kind) }));
    await page.goto("https://my.smartthings.com/location/test-office");
    const executor = new SmartThingsWebUiCommandExecutor(
      () => ({ openCommandPage: async () => page }), (id) => id,
      { onDiagnostic: (value) => diagnostics.push(value) }
    );
    let error;
    try {
      await executor.executeLocationAction({ locationId: "test-office", action,
        confirmationTimeoutMs: expected === "confirmed" ? 3_000 : 600,
        waitForConfirmation: () => { waitStarted = true; return confirmation; }
      });
    } catch (value) { error = value; }
    assert.equal(page.isClosed(), true, `${name}: command page must always close`);
    if (baseline) {
      assert.equal(error, undefined);
      assert.equal(waitStarted, false, "1.8.4 closes before the confirmation hook can run");
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.equal(observed, false, "delayed browser state event was cancelled by early close");
      console.log("REPRODUCED 1.8.4: action clicked, page closed, delayed browser event lost");
      return;
    }
    assert.equal(waitStarted, true, `${name}: confirmation hook must run inside the open page`);
    assert.equal(records.filter((entry) => entry.stage === "action").length, 1, "never retry the mode action");
    assert.equal(records.filter((entry) => entry.stage === "action")[0].trusted, true);
    assert.equal(records.filter((entry) => entry.stage === "cancel").length, 0);
    if (expected === "confirmed") {
      assert.equal(error, undefined, `${name}: ${error?.message}`);
      assert.equal(observed, true);
      assert.ok(records.findIndex((entry) => entry.stage === "observed") <
        records.findIndex((entry) => entry.stage === "closed"), "close only after evidence");
      assert.ok(diagnostics.includes("home_monitor_confirmation_confirmed"));
      assert.equal(records.filter((entry) => entry.stage === "submit").length, kind === "confirm" ? 1 : 0);
    } else {
      assert.equal(error?.message, "command_confirmation_timeout");
      assert.equal(observed, false);
      assert.equal(records.filter((entry) => entry.stage === "submit").length, 0);
      assert.ok(diagnostics.includes("home_monitor_confirmation_timed_out"));
    }
    assert.doesNotMatch(JSON.stringify(diagnostics), /my\.smartthings|test-office|보안/u);
    passed++;
    console.log(`PASS ${name}`);
  } finally { if (!page.isClosed()) await page.close(); }
}
try {
  if (baseline) {
    await run("baseline early page close", "armAway", "delayed");
  } else {
    for (const action of ["armAway", "armStay", "disarm"]) {
      await run(`${action}: delayed security event survives`, action, "delayed");
      await run(`${action}: exact confirmation submits once`, action, "confirm");
    }
    await run("SVG command retains the real page", "armAway", "svg");
    await run("event during the click is not missed", "armAway", "fast");
    for (const kind of ["unrelated", "wrong-mode", "disabled", "duplicate", "no-state"]) {
      await run(`${kind}: no false success and no automatic retry`, "armAway", kind, "timeout");
    }
    console.log(`Home Monitor real-browser lifecycle fixtures: ${passed} passed`);
  }
} finally { await browser.close(); }
