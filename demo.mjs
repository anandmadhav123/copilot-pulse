import fs from 'fs';

// Read the comprehensive test file which has the core logic
const content = fs.readFileSync('src/test/comprehensive.test.mjs', 'utf-8');

// Extract the logic using eval (safe here since we control it)
// We just want to extract RouterLogic and ModelTiering
const logicPart = content.split('// ═══════════════════════════════════════════════════════════════════\n// TEST SUITE')[0]
  .replace("import { describe, it, before, after, beforeEach } from 'node:test';", "")
  .replace("import assert from 'node:assert/strict';", "")
  .replace("import http from 'node:http';", "");

eval(logicPart);

const prompts = [
  { desc: "Very Low Complexity (Lookup)", text: "What is HTTP?" },
  { desc: "Low Complexity (Simple task)", text: "Write a short poem about the moon." },
  { desc: "Medium Complexity (Coding)", text: "Write a function to sort an array using quicksort." },
  { desc: "High Complexity (Debugging)", text: "Debug this race condition in my async thread pool:\n```\n[code snippet]\n```\nTraceback:\n[error logs]" },
  { desc: "Very High Complexity (Architecture)", text: "Architect a scalable microservices event-driven system with distributed tracing, evaluate trade-offs between monolithic and distributed design patterns, and implement deadlock handling." }
];

const config = {
  cheapModel: "openai/gpt-4o-mini",
  strongModel: "openai/gpt-4o",
  threshold: 6.5,
  lowThreshold: 4.0,
  useDynamicTiers: true,
  availableModels: ["openai/gpt-4o-mini", "mistralai/mistral", "anthropic/claude-3.5-sonnet", "openai/o1"]
};

console.log("=== STATIC ROUTING MODE (Binary: Cheap or Strong) ===");
const staticConfig = { ...config, useDynamicTiers: false };
for (const p of prompts) {
  const d = RouterLogic.routeDecision(p.text, staticConfig);
  console.log(`- [${p.desc}]`);
  console.log(`  Prompt: "${p.text.split('\n')[0].substring(0, 50)}..."`);
  console.log(`  Score: ${d.score.toFixed(1)} -> Tier: ${d.tier} -> Selected LLM: ${d.model}\n`);
}

console.log("=== DYNAMIC TIERING MODE (Light, Medium, Heavy based on model strength) ===");
console.log("Available Models:", config.availableModels.join(", "));
console.log("");
for (const p of prompts) {
  const d = RouterLogic.routeDecision(p.text, config);
  console.log(`- [${p.desc}]`);
  console.log(`  Prompt: "${p.text.split('\n')[0].substring(0, 50)}..."`);
  console.log(`  Score: ${d.score.toFixed(1)} -> Tier: ${d.tier} -> Selected LLM: ${d.model}\n`);
}
