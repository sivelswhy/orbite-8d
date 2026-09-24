"use strict";

// Publishes an exported video on TikTok by driving a visible Chromium window.
// The user logs in once in that window; the session is kept in PROFILE_DIR.
// Flow: POST /prepare (upload + caption) → user confirms in Orbite → POST /publish.

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

const BUSY = new Set(["opening", "login", "uploading", "publishing"]);

let context = null;
let page = null;
let videoFile = null;
let job = { state: "idle", message: "" };

function setJob(state, message) {
  job = { state, message };
}

async function getPage() {
  if (!context) {
    const { chromium } = require("playwright");
    context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: null });
    context.on("close", () => { context = null; page = null; });
  }
  if (!page || page.isClosed()) page = context.pages()[0] || (await context.newPage());
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

async function prepare(file, caption) {
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
    setJob("ready", "La vidéo est prête dans TikTok.");
  } catch (error) {
    await fail(error);
  }
}

async function publish() {
  try {
    setJob("publishing", "Publication…");
    const p = await getPage();
    await p.locator(SELECTORS.postButton).first().click();
    const postNow = p.locator(SELECTORS.postNow).first();
    if (await postNow.waitFor({ timeout: 5000 }).then(() => true, () => false)) await postNow.click();
    const left = await p.waitForURL((u) => !u.pathname.includes("/upload"), { timeout: 60_000 }).then(() => true, () => false);
    setJob(left ? "published" : "check", left
      ? "Vidéo publiée sur TikTok."
      : "Le clic sur « Publier » est fait, mais je n'ai pas vu la confirmation : vérifie dans la fenêtre TikTok.");
    removeVideoFile();
  } catch (error) {
    await fail(error);
  }
}

function removeVideoFile() {
  if (videoFile) fs.rm(videoFile, { force: true }, () => {});
  videoFile = null;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

// Routes: GET /api/tiktok/status, POST /api/tiktok/{prepare,publish,cancel}.
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
    const ext = (req.headers["content-type"] || "").includes("webm") ? "webm" : "mp4";
    removeVideoFile();
    videoFile = path.join(os.tmpdir(), `orbite-tiktok-${Date.now()}.${ext}`);
    const out = fs.createWriteStream(videoFile);
    req.pipe(out);
    out.on("finish", () => {
      prepare(videoFile, caption);
      sendJson(res, 202, job);
    });
    out.on("error", (error) => sendJson(res, 500, { message: error.message }));
    return;
  }

  if (action === "publish") {
    if (job.state !== "ready") return sendJson(res, 409, { message: "Aucune vidéo prête à publier." });
    publish();
    return sendJson(res, 202, job);
  }

  if (action === "cancel") {
    removeVideoFile();
    setJob("idle", "Publication annulée.");
    return sendJson(res, 200, job);
  }

  return sendJson(res, 404, { message: "Not found" });
}

module.exports = tiktok;
