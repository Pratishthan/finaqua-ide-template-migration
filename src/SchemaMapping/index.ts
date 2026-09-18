import type ExcelJS from "exceljs";
import {
	byHeader,
	cleanIdentifier,
	type HeaderMap,
	readHeader,
} from "@/SchemaMapping/cells.js";
import type {
	SchemaSpec,
	TableFlow,
	TargetOnlyColumn,
} from "@/SchemaMapping/types.js";

const MAPPING_SHEET = "Mapping";

/** Header labels differ between workbooks - FINFADM writes "Table Name" and
 * "Column Name" where the others write "Table" and "Column" - so each field is
 * looked up under every spelling it appears with. */
const HEADERS = {
	sourceSchema: ["Schema"],
	sourceTable: ["Table", "Table Name"],
	sourceColumn: ["Column", "Column Name"],
	sourceType: ["Data Type"],
	targetSchema: ["Target Schema"],
	targetTable: ["Target Table"],
	targetColumn: ["Target Column Name", "Target Column"],
	targetType: ["PG Data Type"],
	action: ["Action"],
} as const;

/** `Action = "New Column"` marks a target column with no source. */
const TARGET_ONLY = /new\s*column/i;

function field(
	row: ExcelJS.Row,
	header: HeaderMap,
	names: readonly string[],
): string {
	for (const name of names) {
		const value = byHeader(row, header, name);
		if (value) return value;
	}
	return "";
}

/** Column letter for a header, so diagnostics point at a real cell. */
function columnLetter(header: HeaderMap, names: readonly string[]): string {
	for (const name of names) {
		const col = header[name.toLowerCase().replace(/\s+/g, "")];
		if (!col) continue;
		let letters = "";
		let n = col;
		while (n > 0) {
			const rem = (n - 1) % 26;
			letters = String.fromCharCode(65 + rem) + letters;
			n = Math.floor((n - 1) / 26);
		}
		return letters;
	}
	return "?";
}

/**
 * Reads one TgtSchema workbook into per-table flows.
 *
 * Rows are grouped by source table and target table together: the mapping is
 * one-to-one, so a pair is a flow and there is no block structure, no branching
 * and no ordering to recover.
 */
export function parseSchemaWorkbook(
	workbook: ExcelJS.Workbook,
	sourceFile: string,
): SchemaSpec {
	const sheet = workbook.getWorksheet(MAPPING_SHEET);

	if (!sheet) {
		return {
			sourceFile,
			schema: "",
			flows: [],
			targetOnlyTables: [],
			skipped: [{ cell: "-", reason: `no "${MAPPING_SHEET}" sheet` }],
		};
	}

	const header = readHeader(sheet.getRow(1));
	const targetColLetter = columnLetter(header, HEADERS.targetColumn);

	const byPair = new Map<string, TableFlow>();
	const targetOnlyByTable = new Map<string, TargetOnlyColumn[]>();
	const skipped: SchemaSpec["skipped"] = [];
	const schemas = new Set<string>();

	sheet.eachRow((row, rowNumber) => {
		if (rowNumber === 1) return;

		const sourceSchema = cleanIdentifier(
			field(row, header, HEADERS.sourceSchema),
		);
		const sourceTable = cleanIdentifier(
			field(row, header, HEADERS.sourceTable),
		);
		const sourceColumn = field(row, header, HEADERS.sourceColumn);
		const targetSchema = cleanIdentifier(
			field(row, header, HEADERS.targetSchema),
		);
		const targetTable = cleanIdentifier(
			field(row, header, HEADERS.targetTable),
		);
		const targetColumn = field(row, header, HEADERS.targetColumn);
		const action = field(row, header, HEADERS.action);
		const cell = `${sheet.name}!${targetColLetter}${rowNumber}`;

		// Pivot summaries live in spare columns to the right of the mapping, so a
		// row is only data when it names a target table.
		if (!targetTable) return;

		if (targetSchema) schemas.add(targetSchema);

		const targetKey = `${targetSchema}.${targetTable}`.toLowerCase();

		if (TARGET_ONLY.test(action) || !sourceColumn) {
			const bucket = targetOnlyByTable.get(targetKey) ?? [];
			bucket.push({
				targetColumn,
				targetType: field(row, header, HEADERS.targetType),
				cell,
			});
			targetOnlyByTable.set(targetKey, bucket);
			return;
		}

		if (!targetColumn) {
			skipped.push({ cell, reason: "source column with no target column" });
			return;
		}

		if (!sourceTable) {
			skipped.push({ cell, reason: "source column with no source table" });
			return;
		}

		const id = `${sourceSchema}.${sourceTable}->${targetSchema}.${targetTable}`;
		const flow = byPair.get(id) ?? {
			id,
			sourceSchema,
			sourceTable,
			targetSchema,
			targetTable,
			columns: [],
			targetOnly: [],
		};

		flow.columns.push({
			sourceColumn,
			sourceType: field(row, header, HEADERS.sourceType),
			targetColumn,
			targetType: field(row, header, HEADERS.targetType),
			renamed: sourceColumn.toLowerCase() !== targetColumn.toLowerCase(),
			cell,
		});

		byPair.set(id, flow);
	});

	// Attach the target-only columns to the flow that writes their table, and
	// collect the tables that have no mapped column at all.
	const flows = [...byPair.values()];
	const mappedTables = new Set(
		flows.map((f) => `${f.targetSchema}.${f.targetTable}`.toLowerCase()),
	);

	for (const flow of flows) {
		const key = `${flow.targetSchema}.${flow.targetTable}`.toLowerCase();
		flow.targetOnly = targetOnlyByTable.get(key) ?? [];
	}

	const targetOnlyTables = [...targetOnlyByTable.keys()]
		.filter((table) => !mappedTables.has(table))
		.sort();

	return {
		sourceFile,
		schema: [...schemas].sort().join(", "),
		flows: flows.sort((a, b) => a.id.localeCompare(b.id)),
		targetOnlyTables,
		skipped,
	};
}

/** Applies primary/unique keys from an index file to the flows that have one.
 * Flows left without a key are reported rather than emitted, because a plain
 * insert would duplicate rows on a re-run. */
export function applyKeys(
	spec: SchemaSpec,
	keys: Map<string, string[]>,
): { withKey: number; withoutKey: number } {
	let withKey = 0;
	let withoutKey = 0;

	for (const flow of spec.flows) {
		const key = keys.get(
			`${flow.targetSchema}.${flow.targetTable}`.toLowerCase(),
		);
		if (key && key.length > 0) {
			flow.key = key;
			withKey++;
		} else {
			withoutKey++;
		}
	}

	return { withKey, withoutKey };
}
