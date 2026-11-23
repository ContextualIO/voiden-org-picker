// Copies the version from package.json (bumped by `changeset version`) into
// manifest.json, which is what Voiden reads. Only the version string is
// replaced so the rest of manifest.json keeps its formatting.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const text = readFileSync("manifest.json", "utf8");
const previous = JSON.parse(text).version;

if (previous === version) {
  console.log(`manifest.json already at ${version}`);
} else {
  const pattern = /("version"\s*:\s*)"[^"]*"/;
  if (!pattern.test(text)) throw new Error('manifest.json has no "version" field');
  writeFileSync("manifest.json", text.replace(pattern, `$1"${version}"`));
  console.log(`manifest.json ${previous} → ${version}`);
}
