/** Print the EKU-649 reproduction report as Markdown: `bun test/launchpad/eku649/report.ts`. */
import { evaluate } from "./evaluate.js";

const { results, adapter } = await evaluate();
const show = (v: unknown) => `\`${JSON.stringify(v)}\``;
const lines: string[] = ["## EKU-649 bundle through the fixture adapter", ""];
lines.push("| Scenario | Result | Fields matched |", "| --- | --- | --- |");
for (const r of results) {
  const values = r.comparisons.filter((c) => c.context !== true);
  lines.push(`| ${r.id} | ${r.status.replaceAll("_", " ")} | ${values.filter((c) => c.match).length}/${values.length} |`);
}
for (const r of results) {
  lines.push("", `### ${r.id}: ${r.status.replaceAll("_", " ")}`, "", "| Field | Expected | Engine | Match |", "| --- | --- | --- | --- |");
  for (const c of r.comparisons) lines.push(`| ${c.field}${c.context ? " (parameter)" : ""} | ${show(c.expected)} | ${show(c.actual)} | ${c.match ? "yes" : "no"} |`);
  for (const c of r.comparisons.filter((c) => c.note)) lines.push(`- ${c.field}: ${c.note}`);
  for (const n of r.notes) lines.push(`- ${n}`);
}
lines.push("", "### Fixture fields not mapped", "");
for (const f of adapter.unmapped_fields) lines.push(`- \`${f.field}\`: ${f.reason}`);
lines.push("", `### Malformed addresses substituted (${adapter.substitutions.length})`, "");
for (const s of adapter.substitutions) lines.push(`- \`${s.raw}\` (${s.reason}) → \`${s.placeholder}\``);
lines.push("", "### Fixture integrity", "");
lines.push(`- Synthesized block headers: ${adapter.synthesized_headers} (only ${4} headers are in blocks[]).`);
lines.push(`- Launch timestamps inconsistent with 2 s blocks from the head: ${adapter.timestamp_mismatches.length === 0 ? "none" : JSON.stringify(adapter.timestamp_mismatches)}.`);
lines.push(`- Same (block, log_index) used by more than one transaction: ${adapter.duplicate_log_positions.map((d) => `block ${d.block_number} log ${d.log_index}`).join(", ") || "none"}.`);
lines.push(`- Transfers before the token's mint block: ${adapter.transfers_before_mint.length} (${[...new Set(adapter.transfers_before_mint.map((t) => t.tag))].join(", ")}, blocks ${adapter.transfers_before_mint.map((t) => t.block_number).join(", ")}).`);
console.log(lines.join("\n"));
