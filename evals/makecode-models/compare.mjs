#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { quantile } from "./metrics.mjs";

function pairKey(record) {
  const provider = typeof record?.provider === "string" ? record.provider.trim() : "";
  const modelValue = record?.model || record?.requestedModel;
  const model = typeof modelValue === "string" ? modelValue.trim() : "";
  const caseId = typeof record?.caseId === "string" ? record.caseId.trim() : "";
  const repetition = record?.repetition;
  if (!provider || !model || !caseId || !Number.isInteger(repetition) || repetition < 0) {
    throw new Error("Comparison rows require provider, model, caseId, and a non-negative integer repetition");
  }
  return [provider, model, caseId, repetition].join("\u0000");
}

function seededRandom(seed = 0x43ab91) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function bootstrapInterval(deltas, iterations = 2000) {
  if (!deltas.length) return null;
  const random = seededRandom();
  const means = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      sum += deltas[Math.floor(random() * deltas.length)];
    }
    means.push(sum / deltas.length);
  }
  return { low: quantile(means, 0.025), high: quantile(means, 0.975) };
}

function metric(deltas) {
  return {
    pairs: deltas.length,
    rightMinusLeft: deltas.length
      ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length
      : null,
    bootstrap95: bootstrapInterval(deltas)
  };
}

function indexUnique(records, label) {
  const indexed = new Map();
  for (const record of records) {
    const key = pairKey(record);
    if (indexed.has(key)) throw new Error(`${label} run contains duplicate provider/model/case/repetition rows`);
    indexed.set(key, record);
  }
  return indexed;
}

export function compareRuns(leftRecords, rightRecords) {
  const leftByKey = indexUnique(leftRecords, "left");
  const rightByKey = indexUnique(rightRecords, "right");
  const pairs = [...rightByKey.entries()].map(([key, right]) => ({ left: leftByKey.get(key), right }))
    .filter(({ left }) => left);
  const passDeltas = pairs
    .filter(({ left, right }) => (
      typeof left.evaluation?.strictAutomatedProxyPass === "boolean"
        && typeof right.evaluation?.strictAutomatedProxyPass === "boolean"
    ))
    .map(({ left, right }) => (
      Number(right.evaluation.strictAutomatedProxyPass)
        - Number(left.evaluation.strictAutomatedProxyPass)
    ));
  const scoreDeltas = pairs
    .filter(({ left, right }) => Number.isFinite(left.totalScore) && Number.isFinite(right.totalScore))
    .map(({ left, right }) => right.totalScore - left.totalScore);
  return {
    schemaVersion: 1,
    leftRows: leftRecords.length,
    rightRows: rightRecords.length,
    pairedRows: pairs.length,
    unmatchedLeftRows: [...leftByKey.keys()].filter((key) => !rightByKey.has(key)).length,
    unmatchedRightRows: [...rightByKey.keys()].filter((key) => !leftByKey.has(key)).length,
    strictAutomatedProxyPass: metric(passDeltas),
    totalScore: metric(scoreDeltas)
  };
}

async function readJsonl(filePath) {
  return (await readFile(path.resolve(filePath), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--left") options.left = argv[++index];
    else if (arg === "--right") options.right = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.left || !options.right) throw new Error("--left and --right results.jsonl paths are required");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const comparison = compareRuns(await readJsonl(options.left), await readJsonl(options.right));
  const output = JSON.stringify(comparison, null, 2) + "\n";
  if (options.out) await writeFile(path.resolve(options.out), output);
  else process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
