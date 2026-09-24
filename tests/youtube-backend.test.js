const test = require("node:test");
const assert = require("node:assert/strict");

const { getBackendRedirect, isValidSignature, getRuntimeBlockMessage } = require("../api/youtube-audio");

const VIDEO = "https://www.youtube.com/watch?v=abc";

function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try { fn(); } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test("Vercel redirects to the configured backend with a valid signature", () => {
  withEnv({ VERCEL: "1", YTDLP_BACKEND_URL: "https://yt.example.com", YTDLP_BACKEND_SECRET: "s3cret" }, () => {
    assert.equal(getRuntimeBlockMessage(), null);
    const target = new URL(getBackendRedirect(VIDEO));
    assert.equal(target.origin + target.pathname, "https://yt.example.com/api/youtube-audio");
    assert.equal(target.searchParams.get("url"), VIDEO);
    assert.equal(isValidSignature(VIDEO, target.searchParams.get("sig"), "s3cret"), true);
    assert.equal(isValidSignature("https://youtu.be/other", target.searchParams.get("sig"), "s3cret"), false);
  });
});

test("no redirect outside Vercel", () => {
  withEnv({ YTDLP_BACKEND_URL: "https://yt.example.com", YTDLP_BACKEND_SECRET: "s3cret" }, () => {
    delete process.env.VERCEL; delete process.env.VERCEL_ENV; delete process.env.NOW_REGION;
    assert.equal(getBackendRedirect(VIDEO), null);
  });
});

test("rejects missing or malformed signatures", () => {
  assert.equal(isValidSignature(VIDEO, undefined, "s3cret"), false);
  assert.equal(isValidSignature(VIDEO, "abc", "s3cret"), false);
});
