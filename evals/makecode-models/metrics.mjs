function finiteValues(values) {
  return values
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter(Number.isFinite);
}

export function quantile(values, probability) {
  const sorted = finiteValues(values).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = Math.max(0, Math.min(1, probability)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function wilsonInterval(successes, total, z = 1.96) {
  if (!total) return null;
  const rate = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (rate + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((rate * (1 - rate) + (z * z) / (4 * total)) / total) / denominator;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin)
  };
}

function rate(records, field) {
  const measured = records.filter((record) => typeof record.evaluation?.[field] === "boolean");
  const successes = measured.filter((record) => record.evaluation[field] === true).length;
  return {
    successes,
    total: measured.length,
    rate: measured.length ? successes / measured.length : null,
    wilson95: wilsonInterval(successes, measured.length)
  };
}

export function macroMeanTotalScore(records) {
  const scoresByCase = new Map();
  for (const record of records) {
    if (!Number.isFinite(record.totalScore)) continue;
    const caseId = record.caseId || record.case?.id || "unknown";
    if (!scoresByCase.has(caseId)) scoresByCase.set(caseId, []);
    scoresByCase.get(caseId).push(record.totalScore);
  }
  const caseMeans = [...scoresByCase.values()].map((scores) => (
    scores.reduce((sum, score) => sum + score, 0) / scores.length
  ));
  return caseMeans.length
    ? Number((caseMeans.reduce((sum, score) => sum + score, 0) / caseMeans.length).toFixed(2))
    : null;
}

function summarizeGroup(records) {
  const latency = records.map((record) => record.evaluation?.latencyMs);
  const cost = records.map((record) => record.evaluation?.costUsd);
  const failureClasses = {};
  for (const record of records) {
    const failureClass = record.evaluation?.failureClass;
    if (failureClass) failureClasses[failureClass] = (failureClasses[failureClass] || 0) + 1;
  }
  const strictPasses = records.filter((record) => record.evaluation?.strictAutomatedProxyPass === true).length;
  const knownCosts = finiteValues(cost);
  const usage = records.map((record) => record.normalizedUsage)
    .filter((item) => item && Number(item.attemptsWithUsage) > 0);
  const sumUsage = (field) => usage.reduce((sum, item) => (
    sum + (Number.isFinite(item[field]) ? item[field] : 0)
  ), 0);
  return {
    count: records.length,
    macroMeanTotalScore: macroMeanTotalScore(records),
    staticPolicyPass: rate(records, "staticPolicyPass"),
    automatedProxyPass: rate(records, "automatedProxyPass"),
    strictAutomatedProxyPass: rate(records, "strictAutomatedProxyPass"),
    firstAttemptProxyPass: rate(records, "firstAttemptProxyPass"),
    passWithinBudget: rate(records, "passWithinBudget"),
    conditionalRepairSuccess: rate(records.filter((record) => record.evaluation?.repairEligible), "repaired"),
    fallback: rate(records, "fallback"),
    falseSuccess: rate(records, "falseSuccess"),
    latencyMs: {
      median: quantile(latency, 0.5),
      p95: quantile(latency, 0.95)
    },
    costUsd: {
      median: quantile(cost, 0.5),
      p95: quantile(cost, 0.95),
      totalKnown: knownCosts.reduce((sum, value) => sum + value, 0),
      knownRows: knownCosts.length,
      unknownRows: records.length - knownCosts.length,
      costPerStrictAutomatedProxyPass: strictPasses > 0 && knownCosts.length === records.length
        ? knownCosts.reduce((sum, value) => sum + value, 0) / strictPasses
        : null
    },
    tokens: {
      input: sumUsage("inputTokens"),
      output: sumUsage("outputTokens"),
      reasoning: sumUsage("reasoningTokens"),
      cachedInput: sumUsage("cachedInputTokens"),
      rowsWithUsage: usage.length,
      rowsWithoutUsage: records.length - usage.length
    },
    failureClasses
  };
}

function groupBy(records, getKey) {
  const groups = new Map();
  for (const record of records) {
    const key = getKey(record) || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return Object.fromEntries([...groups.entries()].map(([key, rows]) => [key, summarizeGroup(rows)]));
}

function seededRandom(seed = 0x51f15e) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function pairedBootstrap(records, iterations = 2000) {
  const models = [...new Set(records.map((record) => record.model).filter(Boolean))].sort();
  const comparisons = [];
  for (let leftIndex = 0; leftIndex < models.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < models.length; rightIndex += 1) {
      const left = models[leftIndex];
      const right = models[rightIndex];
      const byPair = new Map();
      for (const record of records) {
        if (record.model !== left && record.model !== right) continue;
        const key = `${record.caseId || record.case?.id || "unknown"}:${record.repetition || 0}`;
        if (!byPair.has(key)) byPair.set(key, {});
        byPair.get(key)[record.model] = record.evaluation?.strictAutomatedProxyPass === true ? 1 : 0;
      }
      const differences = [...byPair.values()]
        .filter((pair) => Number.isFinite(pair[left]) && Number.isFinite(pair[right]))
        .map((pair) => pair[left] - pair[right]);
      if (!differences.length) continue;
      const random = seededRandom(0x51f15e + leftIndex * 101 + rightIndex);
      const samples = [];
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        let total = 0;
        for (let index = 0; index < differences.length; index += 1) {
          total += differences[Math.floor(random() * differences.length)];
        }
        samples.push(total / differences.length);
      }
      comparisons.push({
        left,
        right,
        pairedCases: differences.length,
        strictAutomatedProxyPassRateDelta: differences.reduce((sum, value) => sum + value, 0) / differences.length,
        bootstrap95: {
          low: quantile(samples, 0.025),
          high: quantile(samples, 0.975)
        }
      });
    }
  }
  return comparisons;
}

export function summarizeRecords(records) {
  return {
    overall: summarizeGroup(records),
    byCandidate: groupBy(records, (record) => `${record.provider || "unknown"}/${record.model || record.requestedModel || "unknown"}`),
    byModel: groupBy(records, (record) => record.model),
    byProvider: groupBy(records, (record) => record.provider),
    byTarget: groupBy(records, (record) => record.target || record.case?.target),
    byCategory: groupBy(records, (record) => record.category || record.case?.category),
    pairedModelComparisons: pairedBootstrap(records)
  };
}
