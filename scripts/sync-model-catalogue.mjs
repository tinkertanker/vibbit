import { readFile, writeFile } from "node:fs/promises";
import { createModelCatalogue } from "../shared/model-catalogue.mjs";

const path = new URL("../work.js", import.meta.url);
const source = await readFile(path, "utf8");
const pattern = /  \/\/ BEGIN_MODEL_CATALOGUE\n[\s\S]*?  \/\/ END_MODEL_CATALOGUE/;
if (!pattern.test(source)) throw new Error("Missing model catalogue markers");
const block = "  // BEGIN_MODEL_CATALOGUE\n"
  + createModelCatalogue.toString().split("\n").map((line) => line ? "  " + line : "").join("\n")
  + "\n  // END_MODEL_CATALOGUE";
const next = source.replace(pattern, () => block);
if (next !== source) {
  if (process.argv.includes("--check")) throw new Error("Run npm run sync:model-catalogue");
  await writeFile(path, next);
}
console.log("Model catalogue block is in sync.");
