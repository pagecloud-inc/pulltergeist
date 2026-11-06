const fs = require("node:fs");
const path = require("node:path");
const { Resvg } = require("@resvg/resvg-js");

const icons = path.resolve(__dirname, "../icons");
const svg = fs.readFileSync(path.join(icons, "logo.svg"), "utf8");
for (const size of [16, 32, 48, 128]) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" }).render().asPng();
  fs.writeFileSync(path.join(icons, `icon-${size}.png`), png);
}
