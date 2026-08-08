/**
 * End-to-end smoke run against the built app in a real browser.
 *
 * This exists because unit tests cannot prove the thing that matters here: that a
 * session started in the UI lands in IndexedDB, survives a reload, and reaches a
 * configured backend. Every assertion below is a user-visible outcome, not an internal.
 *
 *   node scripts/smoke.mjs            # run
 *   SMOKE_SHOTS=1 node scripts/smoke.mjs   # also write screenshots to .smoke/
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const APP_PORT = 4173;
const API_PORT = 4111;
const SHOTS = process.env.SMOKE_SHOTS === "1";
const SHOT_DIR = ".smoke";

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return true;
    } catch {
      // Server not up yet.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let browserHandle = null;
const processes = [];
function launch(command, args, env) {
  // Detached so each child leads its own process group: `npx` re-spawns the real
  // binary as a grandchild, and killing only the direct child would orphan the port
  // holder and leave the run hanging on a still-open handle.
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: "pipe", detached: true });
  processes.push(child);
  return child;
}

function killTree(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function main() {
  if (SHOTS) {
    rmSync(SHOT_DIR, { recursive: true, force: true });
    mkdirSync(SHOT_DIR, { recursive: true });
  }
  rmSync("server/data", { recursive: true, force: true });

  launch("node", ["server/index.js"], { POMO_PORT: String(API_PORT), POMO_DATA: "server/data/smoke.sqlite" });
  launch("npx", ["vite", "preview", "--port", String(APP_PORT), "--strictPort"], {});

  await waitForHttp(`http://localhost:${API_PORT}/health`);
  await waitForHttp(`http://localhost:${APP_PORT}/`);

  // Honour a preinstalled browser when the environment ships one whose build number
  // does not match this Playwright release; downloading a second copy is wasteful.
  const executablePath = [process.env.SMOKE_CHROMIUM, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(
    (candidate) => candidate && existsSync(candidate),
  );
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  browserHandle = browser;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto(`http://localhost:${APP_PORT}/`);
  await page.waitForSelector("text=Start focus", { timeout: 15_000 });
  check("app boots to the timer", true);
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/01-focus.png` });

  // --- Areas, projects and tasks ------------------------------------------------
  await page.getByRole("button", { name: "Tasks", exact: true }).first().click();
  await page.getByRole("button", { name: "Area" }).click();
  await page.getByPlaceholder("e.g. Engineering craft").fill("Career");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: "Career" }).waitFor({ timeout: 10_000 });
  check("created an area", true);

  await page.getByPlaceholder("What needs doing?").fill("Write the design doc");
  await page.getByRole("button", { name: "Add" }).click();
  await page.waitForSelector("text=Write the design doc");
  check("created a task", true);
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/02-tasks.png` });

  // --- A focus session, shortened so the run is observable ----------------------
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  const focusField = page.locator('input[type="number"]').first();
  await focusField.fill("1");
  await focusField.blur();

  await page.getByRole("button", { name: "Focus", exact: true }).first().click();
  await page.getByLabel("Task for this session").selectOption({ index: 1 });
  await page.getByRole("button", { name: /Start focus/ }).click();
  await page.waitForSelector("text=Pause", { timeout: 5_000 });
  check("timer starts and shows running controls", true);

  await page.getByRole("button", { name: /Distracted/ }).click();
  check("distraction counter is reachable mid-session", await page.getByRole("button", { name: /Distracted \(1\)/ }).isVisible());
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/03-running.png` });

  check(
    "an in-flight session is not reported as stopped early",
    !(await page.getByText("stopped early").isVisible().catch(() => false)),
  );

  // A running session must survive a reload — this is the crash-recovery path.
  await page.reload();
  await page.waitForSelector("text=Pause", { timeout: 15_000 });
  check("running session survives a page reload", true);

  const sessionRows = await page.evaluate(async () => {
    const request = indexedDB.open("pomo");
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly").objectStore("sessions").getAll();
      tx.onsuccess = () => resolve(tx.result);
      tx.onerror = () => reject(tx.error);
    });
  });
  check(
    "session row written at start, with the task attached",
    sessionRows.length === 1 && sessionRows[0].taskId !== null,
    `${sessionRows.length} row(s)`,
  );

  await page.getByRole("button", { name: /Stop/ }).click();
  await page.waitForSelector("text=Start focus", { timeout: 5_000 });
  check("stopping returns the timer to idle", true);

  // --- Habits -------------------------------------------------------------------
  await page.getByRole("button", { name: "Habits", exact: true }).first().click();
  await page.getByRole("button", { name: /New habit/ }).click();
  await page.getByPlaceholder("e.g. Read 20 pages").fill("Read 20 pages");
  await page.getByRole("button", { name: "Create habit" }).click();
  await page.waitForSelector("text=Read 20 pages");
  await page.getByRole("button", { name: /Complete Read 20 pages/ }).click();
  await page.waitForSelector("text=1 day streak", { timeout: 5_000 });
  check("habit check-in updates the streak immediately", true);
  check(
    "a habit kept on its first day reads as fully kept, not 0%",
    await page.getByText("100% kept").isVisible(),
  );
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/04-habits.png` });

  // --- Journal ------------------------------------------------------------------
  await page.getByRole("button", { name: "Journal", exact: true }).first().click();
  await page.getByPlaceholder("One line that sums up the day").fill("Shipped the first slice");
  await page.getByRole("button", { name: /Save entry/ }).click();
  await sleep(400);
  check("journal entry saves", await page.getByText("Saved").isVisible());
  const trailVisible = await page.getByText(/Completed “Write the design doc”|Added task/).first().isVisible();
  check("activity trail records what happened that day", trailVisible);
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/05-journal.png` });

  // --- Insights -----------------------------------------------------------------
  // Seed three weeks of completed sessions straight into IndexedDB. An empty chart
  // proves only that the component mounts; the point is that it plots real rows.
  const seeded = await page.evaluate(async () => {
    const request = indexedDB.open("pomo");
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const areaId = (
      await new Promise((resolve) => {
        const query = db.transaction("areas", "readonly").objectStore("areas").getAll();
        query.onsuccess = () => resolve(query.result);
      })
    )[0]?.id ?? null;

    const rows = [];
    for (let back = 1; back <= 20; back += 1) {
      const day = new Date();
      day.setDate(day.getDate() - back);
      day.setHours(9 + (back % 6), 0, 0, 0);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      for (let n = 0; n < 1 + (back % 3); n += 1) {
        rows.push({
          id: crypto.randomUUID(),
          createdAt: day.getTime(),
          updatedAt: day.getTime(),
          deletedAt: null,
          dirty: 1,
          kind: "focus",
          taskId: null,
          projectId: null,
          areaId,
          startedAt: day.getTime() + n * 1800000,
          endedAt: day.getTime() + n * 1800000 + 1500000,
          plannedMs: 1500000,
          actualMs: 1500000,
          completed: true,
          interruptions: 0,
          note: "",
          dayKey: key,
        });
      }
    }
    await new Promise((resolve, reject) => {
      const store = db.transaction("sessions", "readwrite").objectStore("sessions");
      for (const row of rows) store.put(row);
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => reject(store.transaction.error);
    });
    return rows.length;
  });

  await page.reload();
  await page.waitForSelector("text=Start focus", { timeout: 15_000 });
  await page.getByRole("button", { name: "Insights", exact: true }).first().click();
  await page.waitForSelector("text=Focus per day", { timeout: 15_000 });
  const bars = await page.locator(".recharts-bar-rectangle").count();
  check("insights plots real session history", bars > 5, `${bars} bars from ${seeded} seeded sessions`);
  const streakText = await page.getByText(/day focus streak/).innerText();
  check("focus streak reflects the seeded history", !streakText.startsWith("0 "), streakText);
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/06-insights.png` });

  // --- Sync to the local storage server -----------------------------------------
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("button", { name: /Local storage server/ }).click();
  await page.getByPlaceholder("http://localhost:4000").fill(`http://localhost:${API_PORT}`);
  await page.getByPlaceholder("http://localhost:4000").blur();
  await page.getByRole("button", { name: "Test connection" }).click();
  await page.waitForSelector("text=/Connected to pomo-local-server/", { timeout: 10_000 });
  check("connection test reaches the local server", true);

  await page.getByRole("button", { name: /Sync now/ }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes("Last sync via rest"),
    undefined,
    { timeout: 15_000 },
  );
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/07-settings-sync.png` });

  const serverTasks = await (await fetch(`http://localhost:${API_PORT}/records/tasks?since=0`)).json();
  const serverSessions = await (await fetch(`http://localhost:${API_PORT}/records/sessions?since=0`)).json();
  const serverHabits = await (await fetch(`http://localhost:${API_PORT}/records/habits?since=0`)).json();
  check(
    "tasks, sessions and habits reached the server",
    serverTasks.rows.length === 1 && serverSessions.rows.length >= 1 && serverHabits.rows.length === 1,
    `tasks=${serverTasks.rows.length} sessions=${serverSessions.rows.length} habits=${serverHabits.rows.length}`,
  );
  check(
    "the local-only dirty flag never left the device",
    serverTasks.rows.every((row) => !("dirty" in row)),
  );

  // A second browser profile pointed at the same server must receive the data — this
  // is the whole point of having a backend at all.
  const second = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page2 = await second.newPage();
  await page2.goto(`http://localhost:${APP_PORT}/`);
  await page2.waitForSelector("text=Start focus", { timeout: 15_000 });
  await page2.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page2.getByRole("button", { name: /Local storage server/ }).click();
  await page2.getByPlaceholder("http://localhost:4000").fill(`http://localhost:${API_PORT}`);
  await page2.getByPlaceholder("http://localhost:4000").blur();
  await page2.getByRole("button", { name: /Sync now/ }).click();
  await page2.getByRole("button", { name: "Tasks", exact: true }).first().click();
  await page2.waitForSelector("text=Write the design doc", { timeout: 15_000 });
  check("a second device pulls the same data down", true);
  if (SHOTS) await page2.screenshot({ path: `${SHOT_DIR}/08-second-device.png` });

  // --- Themes -------------------------------------------------------------------
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByLabel("Theme").selectOption("light");
  await sleep(300);
  check("light theme applies", (await page.locator("html").getAttribute("data-theme")) === "light");
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/09-light.png` });
  await page.getByLabel("Theme").selectOption("dark");

  check("no console errors during the run", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  await browser.close();

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (cause) {
  console.error("\nSmoke run threw:", cause);
  process.exitCode = 1;
} finally {
  await browserHandle?.close().catch(() => {});
  for (const child of processes) killTree(child);
}
