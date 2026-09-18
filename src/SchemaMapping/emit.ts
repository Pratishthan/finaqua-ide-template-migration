import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSql, type FlowSql } from "@/SchemaMapping/generate.js";
import { buildTab, type Node } from "@/SchemaMapping/nodered.js";
import type { SchemaSpec } from "@/SchemaMapping/types.js";

/** Matches every `${NAME}` placeholder the generated nodes carry. */
const PLACEHOLDER = /\$\{([^}]+)\}/g;

export type EmitResult = {
	schema: string;
	tabs: number;
	nodes: number;
	upsert: number;
	blocked: number;
	files: string[];
};

async function writeJson(file: string, data: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** Collects every placeholder name used anywhere in the flow, so server.json
 * lists exactly the values a deployment must supply and nothing more. */
export function collectPlaceholders(nodes: Node[]): string[] {
	const found = new Set<string>();

	for (const node of nodes) {
		for (const value of Object.values(node)) {
			if (typeof value !== "string") continue;
			for (const match of value.matchAll(PLACEHOLDER)) {
				if (match[1]) found.add(match[1]);
			}
		}
	}

	return [...found].sort();
}

/**
 * Writes one deployable bundle per target schema.
 *
 * Splitting by schema rather than emitting a single file keeps each
 * node-red-flows.json openable in the Node-RED editor - all 1,253 tables in one
 * file would be roughly 19,000 nodes - and matches how the schemas are deployed.
 */
export async function emitSchema(
	spec: SchemaSpec,
	destination: string,
): Promise<EmitResult> {
	const schema = spec.schema || path.basename(spec.sourceFile, ".xlsx");
	const outDir = path.join(destination, schema);

	const nodes: Node[] = [];
	let upsert = 0;
	let blocked = 0;
	const sqls: FlowSql[] = [];

	for (const flow of spec.flows) {
		const sql = buildSql(flow);
		sqls.push(sql);

		if (sql.writeMode === "upsert") upsert++;
		else blocked++;

		nodes.push(...buildTab(sql, { namespace: schema }));
	}

	const placeholders = collectPlaceholders(nodes);

	const flowsFile = path.join(outDir, "node-red-flows.json");
	const serverFile = path.join(outDir, "server.json");
	const coverageFile = path.join(outDir, "coverage.md");

	await writeJson(flowsFile, nodes);
	await writeJson(serverFile, {
		flow: [],
		providers: [],
		placeholders: Object.fromEntries(placeholders.map((p) => [p, ""])),
	});
	await writeFile(coverageFile, renderCoverage(schema, sqls, spec), "utf8");

	return {
		schema,
		tabs: spec.flows.length,
		nodes: nodes.length,
		upsert,
		blocked,
		files: [flowsFile, serverFile, coverageFile],
	};
}

/** The document a reviewer signs off on: what was generated, what was excluded,
 * and every table that cannot yet be loaded idempotently. */
function renderCoverage(
	schema: string,
	sqls: FlowSql[],
	spec: SchemaSpec,
): string {
	const lines: string[] = [`# ${schema} - migration coverage\n`];

	const columns = sqls.reduce((a, s) => a + s.flow.columns.length, 0);
	const targetOnly = sqls.reduce((a, s) => a + s.flow.targetOnly.length, 0);
	const renamed = sqls.flatMap((s) => s.flow.columns.filter((c) => c.renamed));
	const blocked = sqls.filter((s) => s.writeMode !== "upsert");

	lines.push(`- tables generated: **${sqls.length}**`);
	lines.push(`- columns mapped: **${columns}**`);
	lines.push(`- target-only columns excluded: **${targetOnly}**`);
	lines.push(`- renamed columns: **${renamed.length}**`);
	lines.push(`- tables written as UPSERT: **${sqls.length - blocked.length}**`);
	lines.push(`- tables blocked (no key): **${blocked.length}**`);
	lines.push(
		`- target-only tables excluded: **${spec.targetOnlyTables.length}**\n`,
	);

	if (renamed.length > 0) {
		lines.push("## Renamed columns\n");
		lines.push("| table | source column | target column | cell |");
		lines.push("|---|---|---|---|");
		for (const c of renamed) {
			const owner = sqls.find((s) => s.flow.columns.includes(c))?.flow;
			lines.push(
				`| ${owner?.targetTable ?? "?"} | \`${c.sourceColumn}\` | \`${c.targetColumn}\` | ${c.cell} |`,
			);
		}
		lines.push("");
	}

	if (blocked.length > 0) {
		lines.push("## Blocked - no key, cannot be made idempotent\n");
		lines.push(
			"These tables are generated but will re-insert on a second run. Supply their keys in the index file to switch them to UPSERT.\n",
		);
		for (const s of blocked) {
			lines.push(`- \`${s.flow.targetSchema}.${s.flow.targetTable}\``);
		}
		lines.push("");
	}

	if (spec.targetOnlyTables.length > 0) {
		// Listed, not just counted: the brief puts target-only tables out of scope,
		// and a reviewer has to be able to check that decision table by table.
		lines.push("## Excluded - target-only, no source mapping\n");
		for (const table of spec.targetOnlyTables) lines.push(`- \`${table}\``);
		lines.push("");
	}

	return lines.join("\n");
}
