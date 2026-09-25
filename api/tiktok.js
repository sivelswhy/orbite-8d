"use strict";

// Posts an exported video on TikTok by driving a visible Chromium window:
// upload + caption, then either clicks "Post" itself (auto) or waits for the
// user's click. Once TikTok has left the upload page, the window is closed.
// The user logs in once in that window; the session is kept in PROFILE_DIR.

const fs = require("fs");
const os = require("os");
const path = require("path");

const PROFILE_DIR = path.join(os.homedir(), ".orbite-8d", "tiktok-profile");
const UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload?from=upload";
const LOGIN_TIMEOUT = 5 * 60_000;
const PROCESS_TIMEOUT = 5 * 60_000;

// TikTok changes its upload page from time to time: these are the places to fix.
const SELECTORS = {
  fileInput: 'input[type="file"][accept*="video"]',
  caption: '.public-DraftEditor-content, div[contenteditable="true"]',
  postButton: 'button[data-e2e="post_video_button"]',
  // Optional second dialog after "Post" (content check, "post anyway"…).
  postNow: 'div[role="dialog"] button:has-text("Post now"), div[role="dialog"] button:has-text("Publier maintenant")',
};

const BUSY = new Set(["opening", "login", "uploading", "posting"]);
const POST_TIMEOUT = 5 * 60_000; // after the click, time for TikTok (and any "post now" dialog)

let context = null;
let page = null;
let videoFile = null;
let job = { state: "idle", message: "" };
let resolvePostClick = null; // pending wait for the user's click on "Post"

function setJob(state, message) {
  job = { state, message };
}

async function getPage() {
  if (!context) {
    const { chromium } = require("playwright");
    context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: null });
    context.on("close", () => {
      context = null;
      page = null;
      if (resolvePostClick) resolvePostClick(false);
      if (job.state !== "published") setJob("idle", "Fenêtre TikTok fermée.");
    });
  }
  if (!page || page.isClosed()) {
    page = context.pages()[0] || (await context.newPage());
    // Called from the page when the user clicks "Post" (survives the navigation that follows).
    await page.exposeFunction("orbitePostClicked", () => resolvePostClick && resolvePostClick(true));
  }
  return page;
}

async function isLoggedIn() {
  const cookies = await context.cookies("https://www.tiktok.com");
  return cookies.some((c) => c.name === "sessionid" && c.value);
}

// Opens the upload page, waiting (up to 5 min) for the user to log in if needed.
async function openUploadPage(p) {
  await p.goto(UPLOAD_URL, { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + LOGIN_TIMEOUT;
  while (!(await p.locator(SELECTORS.fileInput).count())) {
    if (Date.now() > deadline) throw new Error("Connexion à TikTok non détectée après 5 minutes.");
    if (!(await isLoggedIn())) {
      setJob("login", "Connecte-toi à TikTok dans la fenêtre Chromium qui vient de s'ouvrir.");
    } else if (!p.url().includes("/upload")) {
      await p.goto(UPLOAD_URL, { waitUntil: "domcontentloaded" });
    }
    await p.waitForTimeout(2000);
  }
}

async function fillCaption(p, caption) {
  const editor = p.locator(SELECTORS.caption).first();
  await editor.waitFor({ timeout: PROCESS_TIMEOUT });
  await editor.click();
  await p.keyboard.press("ControlOrMeta+A");
  await p.keyboard.press("Backspace");
  await p.keyboard.type(caption, { delay: 25 });
  await p.keyboard.press("Escape"); // closes the hashtag suggestions
}

// Post button becomes enabled once TikTok has finished processing the upload.
async function waitPostEnabled(p) {
  await p.locator(SELECTORS.postButton).first().waitFor({ timeout: PROCESS_TIMEOUT });
  await p.waitForFunction((sel) => {
    const b = document.querySelector(sel);
    return b && !b.disabled && b.getAttribute("aria-disabled") !== "true" && b.getAttribute("data-disabled") !== "true";
  }, SELECTORS.postButton, { timeout: PROCESS_TIMEOUT, polling: 1000 });
}

async function fail(error) {
  let shot = "";
  try {
    if (page && !page.isClosed()) {
      shot = path.join(os.tmpdir(), `orbite-tiktok-erreur-${Date.now()}.png`);
      await page.screenshot({ path: shot });
    }
  } catch (_) {}
  setJob("error", `${error.message}${shot ? ` (capture : ${shot})` : ""}`);
}

async function prepare(file, caption, auto) {
  try {
    setJob("opening", "Ouverture de TikTok…");
    const p = await getPage();
    await p.bringToFront();
    await openUploadPage(p);
    setJob("uploading", "Envoi de la vidéo à TikTok…");
    await p.locator(SELECTORS.fileInput).first().setInputFiles(file);
    await fillCaption(p, caption);
    setJob("uploading", "TikTok traite la vidéo…");
    await waitPostEnabled(p);
    if (auto) return await autoPost(p);
    await p.bringToFront();
    setJob("ready", "La vidéo et la légende sont prêtes dans la fenêtre TikTok : vérifie, puis clique toi-même sur « Publier ».");
    closeAfterPost(p);
  } catch (error) {
    await fail(error);
  }
}

// Clicks "Post" (and "Post now" if TikTok asks), then waits for the confirmation.
async function autoPost(p) {
  setJob("posting", "Publication en cours sur TikTok…");
  await p.locator(SELECTORS.postButton).first().click();
  const postNow = p.locator(SELECTORS.postNow).first();
  if (await postNow.waitFor({ timeout: 5000 }).then(() => true, () => false)) await postNow.click();
  await finishPost(p);
}

// Waits for the user's own click on "Post", then for the confirmation.
async function closeAfterPost(p) {
  const clicked = await new Promise((resolve) => {
    resolvePostClick = resolve;
    p.evaluate((sel) => {
      document.querySelector(sel).addEventListener("click", () => window.orbitePostClicked(), { once: true });
    }, SELECTORS.postButton).catch(() => resolve(false));
  });
  resolvePostClick = null;
  if (!clicked) return;
  setJob("posting", "Publication en cours sur TikTok…");
  await finishPost(p);
}

// TikTok leaving the upload page = posted: the window is then closed.
async function finishPost(p) {
  const posted = await p.waitForURL((u) => !u.pathname.includes("/upload"), { timeout: POST_TIMEOUT }).then(() => true, () => false);
  if (!posted) {
    setJob("check", "Je n'ai pas vu TikTok confirmer la publication : la fenêtre reste ouverte, vérifie.");
    return;
  }
  setJob("published", "Vidéo publiée : fenêtre TikTok fermée.");
  removeVideoFile();
  await p.waitForTimeout(1500);
  if (context) await context.close().catch(() => {});
}

function removeVideoFile() {
  if (videoFile) fs.rm(videoFile, { force: true }, () => {});
  videoFile = null;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

// Routes: GET /api/tiktok/status, POST /api/tiktok/prepare?caption=…&auto=1.
// Without auto=1, posting is left to the user's own click in TikTok.
// POSTs require the X-Orbite header, so other websites cannot trigger them
// (a custom header forces a CORS preflight, which this server never approves).
function tiktok(req, res) {
  const url = new URL(req.url, "http://localhost");
  const action = url.pathname.replace("/api/tiktok/", "");

  if (req.method === "GET" && action === "status") return sendJson(res, 200, job);
  if (req.method !== "POST" || req.headers["x-orbite"] !== "1") return sendJson(res, 405, { message: "Method not allowed" });

  if (action === "prepare") {
    if (BUSY.has(job.state)) return sendJson(res, 409, { message: "Une publication est déjà en cours." });
    const caption = url.searchParams.get("caption") || "";
    const auto = url.searchParams.get("auto") === "1";
    const ext = (req.headers["content-type"] || "").includes("webm") ? "webm" : "mp4";
    removeVideoFile();
    videoFile = path.join(os.tmpdir(), `orbite-tiktok-${Date.now()}.${ext}`);
    const out = fs.createWriteStream(videoFile);
    req.pipe(out);
    out.on("finish", () => {
      prepare(videoFile, caption, auto);
      sendJson(res, 202, job);
    });
    out.on("error", (error) => sendJson(res, 500, { message: error.message }));
    return;
  }

  return sendJson(res, 404, { message: "Not found" });
}

module.exports = tiktok;
