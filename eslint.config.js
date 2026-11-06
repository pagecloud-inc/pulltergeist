const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/", "dist/"] },
  js.configs.recommended,
  {
    files: ["*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, chrome: "readonly", module: "readonly", require: "readonly" },
    },
  },
  {
    files: ["eslint.config.js", "scripts/**/*.js", "tests/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node, ...globals.browser } },
  },
];
