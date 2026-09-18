import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { readHeader, text } from "@/SchemaMapping/cells.js";

/**
 * Loads target-table keys, which is what turns a generated insert into an
 * idempotent UPSERT.
 *
 * The index exports come in two shapes, and both are accepted:
 *
 *   *_key_constraint.csv   schema_name, table_name, constraint_name,
 *                          constraint_type, key_columns
 *                          key_columns is a comma-separated list
 *
 *   *_unique_index.csv     schema_name, table_name, index_name,
 *                          constraint_type, definition
 *                          the columns live inside the CREATE INDEX statement
 *
 * A hand-written `Target Schema, Target Table, Column Name, Ordinal` sheet and a
 * JSON map are also accepted, for a key someone supplies by hand.
 */
export type KeyMap = Map<string, string[]>;

/** Constraint kinds that identify a row. FOREIGN KEY is deliberately absent:
 * a foreign key is not unique, and upserting on one would collapse every child
 * row onto its parent. */
const UNIQUE_KINDS = new Set(["PRIMARY KEY", "UNIQUE", "UNIQUE INDEX"]);

type Candidate = {
	schema: string;
	table: string;
	name: string;
	kind: string;
	columns: string[];
};

/** Header labels reduced to letters and digits, so `schema_name`, `Schema Name`
 * and `SchemaName` all resolve to the same field. Index exports separate words
 * with underscores where the hand-written sheets use spaces. */
function headerKey(label: string): string {
	return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tableId(schema: string, table: string): string {
	return `${schema}.${table}`.toLowerCase().trim();
}

/**
 * Splits CSV into records, honouring quoted fields that contain commas *or
 * newlines* - one index definition wraps a multi-line CASE expression, which a
 * line-by-line reader would tear in half.
 */
export function parseCsv(body: string): Record<string, string>[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;

	for (let i = 0; i < body.length; i++) {
		const char = body[i];

		if (quoted) {
			if (char === '"') {
				if (body[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				field += char;
			}
			continue;
		}

		if (char === '"') {
			quoted = true;
		} else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\r") {
			// handled by the \n that follows
		} else if (char === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else {
			field += char;
		}
	}

	if (field || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	const header = rows.shift();
	if (!header) return [];

	const labels = header.map(headerKey);

	return rows
		.filter((r) => r.some((cell) => cell.trim()))
		.map((r) => {
			const record: Record<string, string> = {};
			labels.forEach((label, index) => {
				record[label] = (r[index] ?? "").trim();
			});
			return record;
		});
}

/** Column list from a CREATE [UNIQUE] INDEX statement: the parenthesised group
 * after USING <method>. Returns nothing for an expression index - a CASE or a
 * function cannot be matched on, so such an index is not a usable key. */
export function columnsFromDefinition(definition: string): string[] {
	const using = definition.search(/USING\s+\w+\s*\(/i);
	if (using === -1) return [];

	const open = definition.indexOf("(", using);
	let depth = 0;
	let close = -1;

	for (let i = open; i < definition.length; i++) {
		if (definition[i] === "(") depth++;
		else if (definition[i] === ")") {
			depth--;
			if (depth === 0) {
				close = i;
				break;
			}
		}
	}

	if (close === -1) return [];

	const inner = definition.slice(open + 1, close);

	// A nested paren means an expression rather than a plain column list.
	if (inner.includes("(")) return [];

	return inner
		.split(",")
		.map((c) => c.trim().replace(/\s+(ASC|DESC|NULLS\s+\w+)$/i, ""))
		.filter(Boolean);
}

function candidateFrom(record: Record<string, string>): Candidate | undefined {
	const schema = record.schemaname ?? record.targetschema ?? "";
	const table = record.tablename ?? record.targettable ?? "";
	if (!table) return undefined;

	const kind = (record.constrainttype ?? "").toUpperCase().trim();
	const name = record.constraintname ?? record.indexname ?? "";

	if (record.definition !== undefined) {
		if (kind && !UNIQUE_KINDS.has(kind)) return undefined;
		const columns = columnsFromDefinition(record.definition);
		return columns.length > 0
			? { schema, table, name, kind: kind || "UNIQUE INDEX", columns }
			: undefined;
	}

	if (record.keycolumns !== undefined) {
		if (!UNIQUE_KINDS.has(kind)) return undefined;
		const columns = record.keycolumns
			.split(",")
			.map((c) => c.trim())
			.filter(Boolean);
		return columns.length > 0
			? { schema, table, name, kind, columns }
			: undefined;
	}

	return undefined;
}

/**
 * Picks one key per table.
 *
 * A primary key wins over a unique index; failing that the narrowest key wins,
 * because fewer columns means a cheaper match and less chance of a nullable
 * column creeping in. Ties break on name so the choice is stable across runs.
 */
function choose(candidates: Candidate[]): Candidate | undefined {
	return [...candidates].sort((a, b) => {
		const pk = (c: Candidate) => (c.kind === "PRIMARY KEY" ? 0 : 1);
		return (
			pk(a) - pk(b) ||
			a.columns.length - b.columns.length ||
			a.name.localeCompare(b.name)
		);
	})[0];
}

/** One row per key column: `Target Schema, Target Table, Column Name, Ordinal`. */
function fromColumnRows(records: Record<string, string>[]): Candidate[] {
	const byTable = new Map<string, { column: string; ordinal: number }[]>();

	for (const record of records) {
		const schema =
			record.targetschema ?? record.schemaname ?? record.tableschema ?? "";
		const table = record.targettable ?? record.tablename ?? "";
		const column = record.columnname ?? record.column ?? record.keycolumn ?? "";
		if (!table || !column) continue;

		const id = tableId(schema, table);
		const bucket = byTable.get(id) ?? [];
		bucket.push({
			column,
			ordinal: Number(record.ordinal ?? record.position ?? record.seq) || 0,
		});
		byTable.set(id, bucket);
	}

	return [...byTable].map(([id, entries]) => {
		const [schema = "", table = ""] = id.split(".");
		const seen = new Set<string>();
		const columns: string[] = [];

		for (const entry of entries.sort((a, b) => a.ordinal - b.ordinal)) {
			const lower = entry.column.toLowerCase();
			if (seen.has(lower)) continue;
			seen.add(lower);
			columns.push(entry.column);
		}

		return { schema, table, name: "", kind: "PRIMARY KEY", columns };
	});
}

function candidatesFromRecords(records: Record<string, string>[]): Candidate[] {
	const first = records[0];
	if (!first) return [];

	if (first.definition !== undefined || first.keycolumns !== undefined) {
		return records
			.map(candidateFrom)
			.filter((c): c is Candidate => c !== undefined);
	}

	return fromColumnRows(records);
}

/** `{ "lmadm.lm_int_alloc_table": ["srl_num", "bank_id"] }` */
function fromJson(body: string): Candidate[] {
	const parsed: unknown = JSON.parse(body);
	if (parsed === null || typeof parsed !== "object") return [];

	return Object.entries(parsed as Record<string, unknown>)
		.filter(([, columns]) => Array.isArray(columns))
		.map(([id, columns]) => {
			const [schema = "", table = ""] = id.split(".");
			return {
				schema,
				table: table || schema,
				name: "",
				kind: "PRIMARY KEY",
				columns: (columns as unknown[]).filter(
					(c): c is string => typeof c === "string",
				),
			};
		});
}

async function candidatesFromWorkbook(file: string): Promise<Candidate[]> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.readFile(file);
	const records: Record<string, string>[] = [];

	for (const sheet of workbook.worksheets) {
		const header = readHeader(sheet.getRow(1));

		sheet.eachRow((row, rowNumber) => {
			if (rowNumber === 1) return;
			const record: Record<string, string> = {};
			for (const [label, col] of Object.entries(header)) {
				record[headerKey(label)] = text(row.getCell(col).value);
			}
			records.push(record);
		});
	}

	return candidatesFromRecords(records);
}

async function candidatesFromFile(file: string): Promise<Candidate[]> {
	const extension = path.extname(file).toLowerCase();

	if (extension === ".xlsx" || extension === ".xls") {
		return candidatesFromWorkbook(file);
	}

	const body = await readFile(file, "utf8");
	if (extension === ".json") return fromJson(body);

	return candidatesFromRecords(parseCsv(body));
}

export type KeyLoadResult = {
	keys: KeyMap;
	/** Files that were read, for the run log. */
	files: string[];
	/** Candidates rejected, so a missing key is explainable. */
	rejected: { reason: string; count: number }[];
};

/**
 * Reads an index file, or every index file in a folder.
 *
 * The exports arrive as one file per schema, so a folder is the normal case;
 * a single file still works for a hand-written key list.
 */
export async function loadKeyDetail(target: string): Promise<KeyLoadResult> {
	const info = await stat(target);
	const files = info.isDirectory()
		? (await readdir(target))
				.filter((f) => /\.(csv|json|xlsx?)$/i.test(f) && !f.startsWith("~$"))
				.map((f) => path.join(target, f))
				.sort()
		: [target];

	const candidates: Candidate[] = [];
	for (const file of files)
		candidates.push(...(await candidatesFromFile(file)));

	const byTable = new Map<string, Candidate[]>();
	for (const candidate of candidates) {
		const id = tableId(candidate.schema, candidate.table);
		byTable.set(id, [...(byTable.get(id) ?? []), candidate]);
	}

	const keys: KeyMap = new Map();
	let multi = 0;

	for (const [id, group] of byTable) {
		if (group.length > 1) multi++;
		const winner = choose(group);
		if (winner) keys.set(id, winner.columns);
	}

	return {
		keys,
		files,
		rejected:
			multi > 0
				? [{ reason: "tables with several unique keys", count: multi }]
				: [],
	};
}

/** Convenience wrapper for callers that only need the map. */
export async function loadKeys(target: string): Promise<KeyMap> {
	return (await loadKeyDetail(target)).keys;
}
