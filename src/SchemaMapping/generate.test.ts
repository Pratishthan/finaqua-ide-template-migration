import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSql, wherePlaceholder } from "@/SchemaMapping/generate.js";
import { aquaType, dataSchema, nodeId } from "@/SchemaMapping/nodered.js";
import type { ColumnMapping, TableFlow } from "@/SchemaMapping/types.js";

function column(source: string, target = source): ColumnMapping {
	return {
		sourceColumn: source,
		sourceType: "NVARCHAR2",
		targetColumn: target,
		targetType: "character varying",
		renamed: source.toLowerCase() !== target.toLowerCase(),
		cell: "Mapping!G2",
	};
}

function flow(overrides: Partial<TableFlow> = {}): TableFlow {
	return {
		id: "SVSUSER.ACCT->FINFADM.ACCT",
		sourceSchema: "SVSUSER",
		sourceTable: "ACCT",
		targetSchema: "FINFADM",
		targetTable: "ACCT",
		columns: [column("BANK_ID"), column("SRL_NUM"), column("NAME")],
		targetOnly: [],
		...overrides,
	};
}

test("the projection aliases source columns to their target names", () => {
	const sql = buildSql(
		flow({ columns: [column("DEBIT_ACCT", "DEBIT_ENTITY_ID")] }),
	);
	assert.match(sql.extraction, /SRC\.DEBIT_ACCT AS DEBIT_ENTITY_ID/);
	assert.match(sql.extraction, /FROM SVSUSER\.ACCT SRC/);
});

test("the row filter is left as a deploy-time placeholder", () => {
	const f = flow();
	assert.equal(wherePlaceholder(f), "ACCT_TO_ACCT_WHERE_CLAUSE");
	assert.match(buildSql(f).extraction, /\$\{ACCT_TO_ACCT_WHERE_CLAUSE\}/);
});

test("a flow with no key cannot be upserted and says so", () => {
	// A plain insert would duplicate every row on a re-run, which is exactly what
	// the idempotency requirement exists to prevent - so it is reported.
	const sql = buildSql(flow());
	assert.equal(sql.writeMode, "insert");
	assert.equal(sql.key.length, 0);
	assert.match(sql.problems.join(" "), /no key available/);
});

test("a flow with a key is written as an upsert", () => {
	const sql = buildSql(flow({ key: ["BANK_ID", "SRL_NUM"] }));
	assert.equal(sql.writeMode, "upsert");
	assert.deepEqual(sql.key, ["BANK_ID", "SRL_NUM"]);
	assert.deepEqual(sql.problems, []);
});

test("a key column the mapping never produces is caught", () => {
	// Upserting on a column the SELECT does not emit would match nothing and
	// insert duplicates, so this degrades to insert and reports why.
	const sql = buildSql(flow({ key: ["BANK_ID", "MISSING_COL"] }));
	assert.equal(sql.writeMode, "insert");
	assert.match(sql.problems.join(" "), /MISSING_COL/);
});

test("node ids are deterministic and 16 hex characters", () => {
	// Regenerating an unchanged workbook must produce a byte-identical file,
	// otherwise every diff rewrites all 1,253 tabs and real changes are invisible.
	const first = nodeId("A->B", "writer");
	assert.equal(first, nodeId("A->B", "writer"));
	assert.match(first, /^[0-9a-f]{16}$/);
	assert.notEqual(first, nodeId("A->B", "procedure"));
	assert.notEqual(first, nodeId("A->C", "writer"));
});

test("postgres types map to aqua types, defaulting to string", () => {
	assert.equal(aquaType("character varying(50)"), "string");
	assert.equal(aquaType("integer"), "integer");
	assert.equal(aquaType("bigint"), "long");
	assert.equal(aquaType("timestamp without time zone"), "timestamp");
	assert.equal(aquaType("boolean"), "boolean");
	assert.equal(aquaType("some_unknown_type"), "string");
});

test("the data schema carries the target column names and the key", () => {
	const schema = dataSchema([column("A"), column("B")], ["A"]);
	assert.deepEqual(schema.fields, [
		{ name: "A", type: "string" },
		{ name: "B", type: "string" },
	]);
	assert.deepEqual(schema.key, ["A"]);
});
