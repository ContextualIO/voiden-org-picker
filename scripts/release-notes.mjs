// Prints the CHANGELOG.md section for the current package.json version, for use
// as GitHub release notes. Falls back to a one-liner if there's no entry.
import { existsSync, readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const changelog = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "";

const lines = changelog.split("\n");
const start = lines.findIndex((line) => line.trim() === `## ${version}`);
let notes = "";
if (start !== -1) {
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  notes = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

console.log(notes || `Release v${version}.`);
