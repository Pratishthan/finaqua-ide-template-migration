import type { SchemaSpec, TableFlow } from "@/SchemaMapping/types.js";

/** Alias for the single source table, matching the DB-to-DB flow convention. */
export const SOURCE_ALIAS = "SRC";

export type WriteMode = "upsert" | "insert";

export type FlowSql = {
	flow: TableFlow;
	/** Oracle SELECT run against the source database. */
	extraction: string;
	/** Placeholder resolved at deploy time, so row filters stay explicit. */
	whereClausePlaceholder: string;
	writeMode: WriteMode;
	/** Key columns the upsert matches on; empty when no key is known. */
	key: string[];
	/** Why this flow cannot be written idempotently, when that is the case. */
	problems: string[];
};

/** Deploy-time placeholder name for a flow's row filter. */
export function wherePlaceholder(flow: TableFlow): string {
	const clean = (v: string) => v.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
	return `${clean(flow.sourceTable)}_TO_${clean(flow.targetTable)}_WHERE_CLAUSE`;
}

/**
 * Builds the extraction SQL for one table pair.
 *
 * The projection is aliased to the target column names so the writer never has
 * to re-map: what comes out of the SELECT is already shaped like the target row.
 */
export function buildSql(flow: TableFlow): FlowSql {
	const problems: string[] = [];
	const placeholder = wherePlaceholder(flow);

	const projection = flow.columns
		.map((c) => `${SOURCE_ALIAS}.${c.sourceColumn} AS ${c.targetColumn}`)
		.join(",\n       ");

	const extraction = [
		`SELECT ${projection}`,
		`FROM ${flow.sourceSchema}.${flow.sourceTable} ${SOURCE_ALIAS}`,
		`\${${placeholder}}`,
	].join("\n");

	const key = flow.key ?? [];

	// Without a key an insert is not re-runnable: a second run duplicates every
	// row. The brief asks for idempotent loads, so this is reported rather than
	// quietly downgraded to a plain insert.
	if (key.length === 0) {
		problems.push(
			"no key available - cannot upsert, and a plain insert would duplicate rows on re-run",
		);
	}

	const missingKeyColumns = key.filter(
		(k) =>
			!flow.columns.some(
				(c) => c.targetColumn.toLowerCase() === k.toLowerCase(),
			),
	);

	if (missingKeyColumns.length > 0) {
		problems.push(
			`key column(s) not produced by the mapping: ${missingKeyColumns.join(", ")}`,
		);
	}

	return {
		flow,
		extraction,
		whereClausePlaceholder: placeholder,
		writeMode:
			key.length > 0 && missingKeyColumns.length === 0 ? "upsert" : "insert",
		key,
		problems,
	};
}

export type SchemaCoverage = {
	spec: SchemaSpec;
	tables: number;
	columns: number;
	renamed: number;
	targetOnlyColumns: number;
	targetOnlyTables: number;
	upsertable: number;
	blocked: number;
};

export function coverSchema(spec: SchemaSpec): SchemaCoverage {
	let columns = 0;
	let renamed = 0;
	let targetOnlyColumns = 0;
	let upsertable = 0;
	let blocked = 0;

	for (const flow of spec.flows) {
		columns += flow.columns.length;
		renamed += flow.columns.filter((c) => c.renamed).length;
		targetOnlyColumns += flow.targetOnly.length;
		if (buildSql(flow).writeMode === "upsert") upsertable++;
		else blocked++;
	}

	return {
		spec,
		tables: spec.flows.length,
		columns,
		renamed,
		targetOnlyColumns,
		targetOnlyTables: spec.targetOnlyTables.length,
		upsertable,
		blocked,
	};
}

function pad(v: string | number, w: number): string {
	return String(v).padStart(w);
}

/** One line per workbook plus a total, so the whole migration fits on a screen. */
export function summarizeSchemas(coverages: SchemaCoverage[]): string {
	const lines: string[] = [];

	lines.push(
		`\n${"SCHEMA".padEnd(12)}${pad("TABLES", 8)}${pad("COLUMNS", 9)}${pad("RENAMED", 9)}${pad("TGT-ONLY", 10)}${pad("UPSERT", 8)}${pad("BLOCKED", 9)}`,
	);
	lines.push("-".repeat(65));

	const total = {
		tables: 0,
		columns: 0,
		renamed: 0,
		targetOnly: 0,
		upsertable: 0,
		blocked: 0,
	};

	for (const c of coverages) {
		total.tables += c.tables;
		total.columns += c.columns;
		total.renamed += c.renamed;
		total.targetOnly += c.targetOnlyColumns;
		total.upsertable += c.upsertable;
		total.blocked += c.blocked;

		lines.push(
			`${(c.spec.schema || c.spec.sourceFile).padEnd(12)}${pad(c.tables, 8)}${pad(c.columns, 9)}${pad(c.renamed, 9)}${pad(c.targetOnlyColumns, 10)}${pad(c.upsertable, 8)}${pad(c.blocked, 9)}`,
		);
	}

	lines.push("-".repeat(65));
	lines.push(
		`${"TOTAL".padEnd(12)}${pad(total.tables, 8)}${pad(total.columns, 9)}${pad(total.renamed, 9)}${pad(total.targetOnly, 10)}${pad(total.upsertable, 8)}${pad(total.blocked, 9)}`,
	);

	const targetOnlyTables = coverages.reduce(
		(a, c) => a + c.targetOnlyTables,
		0,
	);
	lines.push(
		`\n${targetOnlyTables} target-only tables excluded (no source mapping)`,
	);

	if (total.blocked > 0) {
		lines.push(
			`${total.blocked} tables cannot be made idempotent until the index files supply their keys`,
		);
	}

	return lines.join("\n");
}
