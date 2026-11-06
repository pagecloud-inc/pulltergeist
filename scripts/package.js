const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function packageFiles(manifest) {
  const files = new Set(["manifest.json", "LICENSE", "icons/LICENSE.octicons"]);
  for (const icon of Object.values(manifest.icons || {})) files.add(icon);
  for (const script of manifest.content_scripts || []) {
    for (const file of [...(script.js || []), ...(script.css || [])]) files.add(file);
  }
  for (const entry of manifest.web_accessible_resources || []) {
    for (const file of entry.resources) files.add(file);
  }
  return [...files].sort();
}

function build() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const files = packageFiles(manifest);
  const missing = files.filter(file => !fs.existsSync(path.join(root, file)));
  if (missing.length) throw new Error(`Missing packaged files: ${missing.join(", ")}`);
  const output = path.join(root, "dist", `pulltergeist-${manifest.version}.zip`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.rmSync(output, { force: true });
  execFileSync("zip", ["-X", "-q", output, ...files], { cwd: root, stdio: "inherit" });
  console.log(path.relative(root, output));
}

if (require.main === module) build();

module.exports = { packageFiles };
