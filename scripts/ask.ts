// Local harness: ask the agent a question against the live mirror, no Slack involved.
// Usage: node --env-file=.env.local scripts/ask.ts "your question"   (add --json to print the raw blocks)
import { answer, render } from "../functions/slackbot/index.ts";

const json = process.argv.includes("--json");
const question = process.argv.slice(2).filter((a) => a !== "--json").join(" ");
const t0 = Date.now();
const result = await answer(question, []);
const r = await render(result);
if (json) console.log(JSON.stringify(r.blocks, null, 1));
else {
	for (const b of r.blocks) {
		if (b.type === "section" && b.text) console.log(b.text.text);
		if (b.type === "section" && b.fields) console.log("[card] " + b.fields.map((f: any) => f.text.replace("\n", ": ")).join(" | "));
		if (b.type === "table") for (const row of b.rows) console.log("| " + row.map((c: any) => c.text ?? c.elements[0].elements[0].text).join(" | ") + " |");
		if (b.type === "context") console.log("(" + b.elements[0].text.replace(/<!date\^\d+\^[^|]+\|([^>]+)>/, "$1") + ")");
	}
}
console.log(`\n--- ${((Date.now() - t0) / 1000).toFixed(1)}s · ${result.queries.length} queries · sensitive=${r.sensitive} · blocks=${r.blocks.map((b) => b.type).join(",")}`);
process.exit(0);
