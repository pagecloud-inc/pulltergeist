const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const manifest = require("../manifest.json");
const pkg = require("../package.json");
const lock = require("../package-lock.json");
const { packageFiles } = require("../scripts/package.js");

test("extension and package metadata use Pulltergeist branding", () => {
  assert.equal(manifest.name, "Pulltergeist");
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(manifest.background, undefined);
  assert.ok(manifest.content_scripts[0].js.includes("warming.js"));
  assert.equal(manifest.content_scripts[0].run_at, "document_end");
  assert.equal(pkg.name, "pulltergeist");
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[""].name, pkg.name);
});

test("manifest, package, and lockfile versions match", () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
});

test("store package includes every manifest-referenced file and nothing dev-only", () => {
  const files = packageFiles(manifest);
  for (const file of files) assert.ok(fs.existsSync(path.resolve(__dirname, "..", file)), file);
  for (const file of [...manifest.content_scripts[0].js, ...manifest.content_scripts[0].css, "icons/icon-32.png", "LICENSE"]) {
    assert.ok(files.includes(file), file);
  }
  assert.ok(files.every(file => !/^(tests|scripts|node_modules|tasks)\//.test(file) && file !== "package.json"));
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
