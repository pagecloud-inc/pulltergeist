const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const manifest = require("../manifest.json");
const pkg = require("../package.json");
const lock = require("../package-lock.json");

test("extension and package metadata use Pulltergeist branding", () => {
  assert.equal(manifest.name, "Pulltergeist");
  assert.equal(pkg.name, "pulltergeist");
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[""].name, pkg.name);
});

test("manifest icons are valid PNGs in every required size", () => {
  for (const size of [16, 32, 48, 128]) {
    const file = manifest.icons[String(size)];
    assert.equal(file, `icons/icon-${size}.png`);
    const png = fs.readFileSync(path.resolve(__dirname, "..", file));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.toString("ascii", 12, 16), "IHDR");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});
