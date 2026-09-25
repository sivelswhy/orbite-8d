const test = require("node:test");
const assert = require("node:assert/strict");

const { getMuxArgs, getStretchArgs } = require("../api/export");

test("mux copies the 30 fps H.264 stream and encodes the WAV to AAC", () => {
  const args = getMuxArgs("/tmp/v.h264", "/tmp/a.wav", "/tmp/out.mp4");
  assert.equal(args.at(-1), "/tmp/out.mp4");
  assert.equal(args[args.indexOf("-framerate") + 1], "30");
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-bsf:v") + 1], "setts=pts=N/(30*TB):dts=N/(30*TB)");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.ok(!args.includes("-shortest"));
});

test("stretch changes the tempo with atempo", () => {
  const args = getStretchArgs("/tmp/in.wav", "/tmp/out.wav", 1.25);
  assert.equal(args[args.indexOf("-filter:a") + 1], "atempo=1.25");
  assert.equal(args.at(-1), "/tmp/out.wav");
});
