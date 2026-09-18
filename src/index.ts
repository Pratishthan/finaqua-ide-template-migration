import { readdir } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import ExcelJS from "exceljs";
import { emitSchema } from "@/SchemaMapping/emit.js";
import {
	buildSql,
	coverSchema,
	summarizeSchemas,
} from "@/SchemaMapping/generate.js";
import { applyKeys, parseSchemaWorkbook } from "@/SchemaMapping/index.js";
import { type KeyMap, loadKeys } from "@/SchemaMapping/keys.js";
import type { SchemaSpec } from "@/SchemaMapping/types.js";
import { resolveDestinationPath, resolveExistingPath } from "@/utils.js";

const program = new Command();

/** Accepts either a single workbook or a folder of them, so one run can cover a
 * single schema or the whole migration. */
async function workbooksIn(sourcePath: string): Promise<string[]> {
	const entries = await readdir(sourcePath).catch(() => null);

	if (entries === null) return [sourcePath];

	return entries
		.filter((f) => /\.xlsx?$/i.test(f) && !f.startsWith("~$"))
		.map((f) => path.join(sourcePath, f))
		.sort();
}

async function readSpecs(sourcePath: string): Promise<SchemaSpec[]> {
	const specs: SchemaSpec[] = [];

	for (const file of await workbooksIn(sourcePath)) {
		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.readFile(file);
		const spec = parseSchemaWorkbook(workbook, path.basename(file));
		if (spec.flows.length > 0) specs.push(spec);
	}

	return specs;
}

async function readKeys(file: string | undefined): Promise<KeyMap> {
	if (!file) return new Map();

	const keys = await loadKeys(file);
	console.log(
		`loaded keys for ${keys.size} tables from ${path.basename(file)}\n`,
	);
	return keys;
}

program
	.name("finaqua-ide-template-migration")
	.description(
		"generates node-red flows for the one-to-one Oracle to Postgres migration",
	);

program
	.command("schema")
	.description(
		"parse the TgtSchema workbooks and report what would be generated",
	)
	.argument("<source>", "TgtSchema workbook or folder", resolveExistingPath)
	.option("-t, --table <name>", "print the extraction SQL for one table")
	.option(
		"-k, --keys <file>",
		"index file of target-table keys",
		resolveExistingPath,
	)
	.action(
		async (sourcePath: string, options: { table?: string; keys?: string }) => {
			const keys = await readKeys(options.keys);
			const specs = await readSpecs(sourcePath);

			for (const spec of specs) applyKeys(spec, keys);

			if (options.table) {
				const wanted = options.table.toLowerCase();

				for (const spec of specs) {
					const flow = spec.flows.find((f) =>
						f.id.toLowerCase().includes(wanted),
					);
					if (!flow) continue;

					const sql = buildSql(flow);
					console.log(`\n${flow.id}\n${"=".repeat(78)}`);
					console.log(
						`columns    ${flow.columns.length} mapped, ${flow.targetOnly.length} target-only (excluded)`,
					);
					console.log(
						`write      ${sql.writeMode}${sql.key.length > 0 ? ` on (${sql.key.join(", ")})` : ""}`,
					);
					console.log(`\n${sql.extraction}\n`);
					for (const problem of sql.problems) console.log(`  ! ${problem}`);
					return;
				}

				console.log(`no table matching '${options.table}'`);
				return;
			}

			console.log(summarizeSchemas(specs.map(coverSchema)));
		},
	);

program
	.command("generate", { isDefault: true })
	.description("write node-red flows from the TgtSchema workbooks")
	.argument("<source>", "TgtSchema workbook or folder", resolveExistingPath)
	.argument("<dest>", "output folder", resolveDestinationPath)
	.option(
		"-k, --keys <file>",
		"index file of target-table keys; without it every table falls back to insert",
		resolveExistingPath,
	)
	.action(
		async (
			sourcePath: string,
			destPath: string,
			options: { keys?: string },
		) => {
			const keys = await readKeys(options.keys);
			const specs = await readSpecs(sourcePath);

			let tabs = 0;
			let nodes = 0;
			let upsert = 0;
			let blocked = 0;

			for (const spec of specs) {
				applyKeys(spec, keys);

				const result = await emitSchema(spec, destPath);
				tabs += result.tabs;
				nodes += result.nodes;
				upsert += result.upsert;
				blocked += result.blocked;

				console.log(
					`${result.schema.padEnd(10)} ${String(result.tabs).padStart(5)} tabs  ${String(result.nodes).padStart(6)} nodes  -> ${path.dirname(result.files[0] ?? "")}`,
				);
			}

			console.log(
				`\n${tabs} tabs, ${nodes} nodes written. ${upsert} upsert, ${blocked} blocked on a missing key.`,
			);
		},
	);

program
	.parseAsync()
	.catch((error: unknown) =>
		program.error(error instanceof Error ? error.message : String(error)),
	);
