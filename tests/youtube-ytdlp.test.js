const test = require("node:test");
const assert = require("node:assert/strict");

const { getYtdlpArgs, isYouTubeUrl } = require("../api/youtube-audio");

test("accepts only HTTPS YouTube URLs", () => {
  assert.equal(isYouTubeUrl("https://www.youtube.com/watch?v=abc"), true);
  assert.equal(isYouTubeUrl("https://youtu.be/abc"), true);
  assert.equal(isYouTubeUrl("http://youtube.com/watch?v=abc"), false);
  assert.equal(isYouTubeUrl("https://evil-youtube.com/watch?v=abc"), false);
});

test("yt-dlp converts to MP3 in the given directory and ends options before the URL", () => {
  const args = getYtdlpArgs("https://youtu.be/abc", "/tmp/out");
  assert.deepEqual(args.slice(-2), ["--", "https://youtu.be/abc"]);
  assert.ok(args.includes("--extract-audio"));
  assert.equal(args[args.indexOf("--audio-format") + 1], "mp3");
  assert.equal(args[args.indexOf("--output") + 1], "/tmp/out/audio.%(ext)s");
});
