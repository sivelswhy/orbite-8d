const test = require("node:test");
const assert = require("node:assert/strict");

const { getRuntimeBlockMessage } = require("../api/youtube-audio");

test("local runtime does not block YouTube downloads", () => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.NOW_REGION;
  assert.equal(getRuntimeBlockMessage(), null);
});

test("Vercel runtime returns a clear anti-bot explanation", () => {
  process.env.VERCEL = "1";
  const message = getRuntimeBlockMessage();
  assert.match(message, /anti-bots|Vercel|backend privé|serveur local/i);
  delete process.env.VERCEL;
});
