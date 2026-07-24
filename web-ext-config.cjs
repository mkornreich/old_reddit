// Configuration for Mozilla's `web-ext` tool (https://extensionworkshop.com).
// Keeps development-only files out of the packaged .zip / .xpi.
module.exports = {
  ignoreFiles: [
    "package.json",
    "package-lock.json",
    "node_modules",
    "web-ext-config.cjs",
    "web-ext-artifacts",
    "README.md",
    "LICENSE",
    ".gitignore",
    "**/*.md",
    // Never bundle secrets or local scripts into the packaged/signed extension.
    "creds.sh",
    "*.sh",
    "scripts",
    "dist",
    "screenshots",
    "vendor/oldreddit.css",
    ".amo-env",
    ".env",
  ],
};
