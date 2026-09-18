import { createHash } from "node:crypto";
import type { FlowSql } from "@/SchemaMapping/generate.js";
import type { ColumnMapping } from "@/SchemaMapping/types.js";

/**
 * Builds one Node-RED tab per table pair, in the aqua node vocabulary that
 * aqua-flowbuilder compiles into batch job configs.
 *
 * The shape is deliberately fixed - read one table, write one table - so there
 * is no incremental graph building here: every id is derived up front and the
 * wiring is written in one pass.
 */

export type Node = Record<string, unknown>;

export type TabOptions = {
	/** Namespace stamped on the job, e.g. the target schema. */
	namespace: string;
	/** Placeholder names for the source and target connections. */
	sourcePrefix?: string;
	targetPrefix?: string;
};

/**
 * Deterministic node ids.
 *
 * Node-RED only requires 16 hex characters, so these are derived from the tab
 * and the node's role rather than randomly generated. Regenerating an unchanged
 * workbook then produces a byte-identical file, which is what makes the output
 * reviewable in a diff - with random ids every regeneration rewrites all 1,253
 * tabs and a real mapping change is impossible to spot.
 */
export function nodeId(tab: string, role: string, ordinal = 0): string {
	return createHash("sha256")
		.update(`${tab}|${role}|${ordinal}`)
		.digest("hex")
		.slice(0, 16);
}

function safe(value: string): string {
	return value.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Postgres type -> aqua schema type.
 *
 * Unrecognised types fall back to string, which is lossless for transport: the
 * target column type is fixed by the target DDL, and the JDBC writer casts on
 * the way in. Worth confirming against the aqua runtime before a production run.
 */
const PG_TO_AQUA: Record<string, string> = {
	"character varying": "string",
	character: "string",
	varchar: "string",
	char: "string",
	text: "string",
	integer: "integer",
	int: "integer",
	smallint: "integer",
	bigint: "long",
	numeric: "double",
	decimal: "double",
	"double precision": "double",
	real: "float",
	boolean: "boolean",
	date: "date",
	timestamp: "timestamp",
	"timestamp without time zone": "timestamp",
	"timestamp with time zone": "timestamp",
	json: "string",
	jsonb: "string",
	uuid: "string",
	bytea: "string",
};

export function aquaType(pgType: string): string {
	const base = pgType.toLowerCase().replace(/\(.*$/, "").trim();
	return PG_TO_AQUA[base] ?? "string";
}

/** The schema block the JDBC writer reads: `fields` shapes the row, `key` is what
 * an upsert matches on. */
export function dataSchema(
	columns: ColumnMapping[],
	key: string[],
): { fields: { name: string; type: string }[]; key: string[] } {
	return {
		fields: columns.map((c) => ({
			name: c.targetColumn,
			type: aquaType(c.targetType),
		})),
		key,
	};
}

/** Builds the read or write chain: connection -> destination -> interface ->
 * gold storage. Both directions use the same node types; only the table and the
 * placeholder prefix differ. */
function jdbcChain(
	tab: string,
	side: "source" | "target",
	opts: {
		namespace: string;
		name: string;
		schemaTable: string;
		prefix: string;
		schema: ReturnType<typeof dataSchema>;
	},
): { nodes: Node[]; storageId: string } {
	const connectionId = nodeId(tab, `${side}.connection`);
	const destinationId = nodeId(tab, `${side}.destination`);
	const interfaceId = nodeId(tab, `${side}.interface`);
	const storageId = nodeId(tab, `${side}.storage`);
	const schemaId = nodeId(tab, `${side}.schema`);

	const nodes: Node[] = [
		{
			id: connectionId,
			type: "aqua_config_jdbc_connection",
			name: `${opts.name}_Connection_${side}`,
			url: `\${${opts.prefix}_DB_URL}`,
			driver: `\${${opts.prefix}_DB_DRIVER}`,
			user: `\${${opts.prefix}_DB_USERNAME}`,
			password: `\${${opts.prefix}_DB_PASSWORD}`,
		},
		{
			id: destinationId,
			type: "aqua_config_storage_destination_jdbc",
			name: `${opts.name}_JDBC_${side}`,
			connection: connectionId,
			// The migration brief forbids altering target tables, so the writer
			// never creates or truncates one.
			table: opts.schemaTable,
			truncateTable: "false",
			tableCreationMode: "none",
			schema: "",
			jdbcSchemaMap: "[]",
			partitionColumn: "",
			lowerBound: "",
			upperBound: "",
			numPartitions: "",
		},
		{
			id: interfaceId,
			type: "aqua_config_storage_gold_interface",
			namespace: opts.namespace,
			name: `${opts.name}_Interface_${side}`,
			storage_type: "JDBC",
			jdbc_destination: destinationId,
			redis_destination: "",
			decrypt: "false",
			privateKeyPath: "",
			passphrase: "",
		},
		{
			id: schemaId,
			type: "aqua_config_schema_data",
			namespace: opts.namespace,
			name: `${opts.name}_Schema_${side}`,
			schema: JSON.stringify(opts.schema),
		},
		{
			id: storageId,
			type: "aqua_config_storage_gold",
			namespace: opts.namespace,
			name: `${opts.name}_Storage_${side}`,
			storage: interfaceId,
			dataschema: schemaId,
		},
	];

	return { nodes, storageId };
}

/** Error sinks, referenced by property rather than wired. */
function errorChain(tab: string, name: string, namespace: string) {
	const kafkaId = nodeId(tab, "error.kafka");
	const errorDbId = nodeId(tab, "error.db");
	const writeKafkaId = nodeId(tab, "error.writeKafka");
	const streamId = nodeId(tab, "error.stream");
	const validationStreamId = nodeId(tab, "error.validationStream");

	const nodes: Node[] = [
		{
			id: kafkaId,
			type: "aqua_config_stream_kafka",
			name: `${name}_Kafka`,
			host: "${ERROR_KAFKA_HOST}",
			port: "${ERROR_KAFKA_PORT}",
		},
		{
			id: errorDbId,
			type: "aqua_config_jdbc_connection",
			name: `${name}_ErrorDB`,
			url: "${ERROR_DB_URL}",
			driver: "${ERROR_DB_DRIVER}",
			user: "${ERROR_DB_USERNAME}",
			password: "${ERROR_DB_PASSWORD}",
		},
		{
			id: writeKafkaId,
			type: "aqua_config_error_action_write_kafka",
			name: `${name}_ErrorKafka`,
			stream: kafkaId,
			topic: "error",
			header: "{}",
			error_db_connection: errorDbId,
		},
		{
			id: streamId,
			type: "aqua_config_error_action_write_stream",
			namespace,
			name: `${name}_ErrorStream`,
			stream_type: "kafka_stream",
			stream: writeKafkaId,
		},
		{
			id: validationStreamId,
			type: "aqua_config_error_action_write_stream",
			namespace,
			name: `${name}_ValidationErrorStream`,
			stream_type: "kafka_stream",
			stream: writeKafkaId,
		},
	];

	return { nodes, streamId, validationStreamId };
}

/**
 * Builds every node for one table's tab.
 *
 * Layout:
 *   aqua_batch_sql_event -> aqua_procedure -> aqua_action_write_gold
 * with the source view, both JDBC chains and the error sinks attached as config
 * nodes rather than wired into the flow.
 */
export function buildTab(sql: FlowSql, options: TabOptions): Node[] {
	const flow = sql.flow;
	const tab = flow.id;
	const name = safe(`${flow.sourceTable}_to_${flow.targetTable}`);
	const namespace = options.namespace || flow.targetSchema;

	const tabId = nodeId(tab, "tab");
	const viewId = nodeId(tab, "view");
	const sourceEventId = nodeId(tab, "sourceEvent");
	const procedureId = nodeId(tab, "procedure");
	const writerId = nodeId(tab, "writer");
	const viewName = safe(`View_${flow.sourceTable}`);

	const schema = dataSchema(flow.columns, sql.key);

	const source = jdbcChain(tab, "source", {
		namespace,
		name,
		schemaTable: `${flow.sourceSchema}.${flow.sourceTable}`,
		prefix: options.sourcePrefix ?? "SRC",
		schema,
	});

	const target = jdbcChain(tab, "target", {
		namespace,
		name,
		schemaTable: `${flow.targetSchema}.${flow.targetTable}`,
		prefix: options.targetPrefix ?? "TGT",
		schema,
	});

	const errors = errorChain(tab, name, namespace);

	const nodes: Node[] = [
		{
			id: tabId,
			type: "tab",
			label: safe(`${namespace}_${flow.targetTable}`),
			disabled: false,
			info: `${flow.sourceSchema}.${flow.sourceTable} -> ${flow.targetSchema}.${flow.targetTable}\n${flow.columns.length} columns, write mode ${sql.writeMode}`,
			env: [],
		},
		...source.nodes,
		...target.nodes,
		...errors.nodes,
		{
			id: viewId,
			type: "aqua_config_view",
			name: viewName,
			storage_type: "gold",
			gold_storage: source.storageId,
			// The extraction SQL runs on the source database, so it stays Oracle.
			query: sql.extraction,
		},
		{
			id: sourceEventId,
			type: "aqua_batch_sql_event",
			z: tabId,
			namespace,
			name: `${name}_Source`,
			job_meta_info: "",
			query: `SELECT * FROM ${viewName}`,
			onerror: errors.streamId,
			onvalidationerror: errors.validationStreamId,
			validatorClass: "",
			validatorParams: "{}",
			arguments: "{}",
			logger: "false",
			meta: "{}",
			pagesize: 0,
			dropDuplicates: false,
			deDupFields: "",
			deDupStrategy: "none",
			deDupOrderFields: "",
			nifiParams: "{}",
			outputViewName: "",
			numofviews: "1",
			view1: viewId,
			view2: "",
			view3: "",
			view4: "",
			view5: "",
			view6: "",
			view7: "",
			view8: "",
			view9: "",
			view10: "",
			x: 300,
			y: 100,
			wires: [[procedureId]],
		},
		{
			id: procedureId,
			type: "aqua_procedure",
			z: tabId,
			namespace,
			name: `${name}_Procedure`,
			logger: "false",
			inputschematype: "input",
			inputschema: "{}",
			onsuccess: "",
			addnlonsuccess1: "",
			addnlonsuccess2: "",
			hdfs: "",
			x: 300,
			y: 200,
			wires: [[writerId]],
		},
		{
			id: writerId,
			type: "aqua_action_write_gold",
			z: tabId,
			namespace,
			name: `${name}_Write`,
			storage: target.storageId,
			// "Action" routes the write through JDBCExecutorSaver, which is the only
			// path that honours `action` (upsert) together with the key list.
			category: "Action",
			action: sql.writeMode,
			StreamAction: "Append",
			onsuccess: "",
			x: 800,
			y: 200,
			wires: [],
		},
	];

	return nodes;
}
