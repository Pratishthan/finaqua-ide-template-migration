/**
 * Model for the one-to-one schema migrations described by the
 * TgtSchema_<SCHEMA>_Phase2.xlsx workbooks.
 *
 * These are lift-and-shift mappings: a source column maps to the target column
 * of the same name, differing only in case and in the Oracle -> Postgres type.
 * Across all five workbooks only 5 of 38,999 mapped columns are actually
 * renamed, so there is no transformation language to interpret here - the work
 * is scope, types and keys.
 */

export type ColumnMapping = {
	sourceColumn: string;
	/** Oracle type as written, e.g. "NVARCHAR2". */
	sourceType: string;
	targetColumn: string;
	/** Postgres type as written, e.g. "character varying". */
	targetType: string;
	/** True when the two names differ by more than case - rare, and worth seeing. */
	renamed: boolean;
	/** Sheet-qualified cell of the target column, for diagnostics. */
	cell: string;
};

/** A target column with no source, marked `Action = "New Column"`. Out of scope
 * per the migration brief, but counted so every row is accounted for. */
export type TargetOnlyColumn = {
	targetColumn: string;
	targetType: string;
	cell: string;
};

/**
 * One source table loaded into one target table.
 *
 * `key` drives the UPSERT. It stays undefined until the index files are
 * supplied; a flow without a key is reported rather than emitted as a plain
 * insert, because a re-run would then duplicate rows - the exact failure the
 * UPSERT requirement exists to prevent.
 */
export type TableFlow = {
	/** e.g. "SVSUSER.ACCSIGNRULEMAP->FINFADM.ACCSIGNRULEMAP". */
	id: string;
	sourceSchema: string;
	sourceTable: string;
	targetSchema: string;
	targetTable: string;
	columns: ColumnMapping[];
	targetOnly: TargetOnlyColumn[];
	key?: string[] | undefined;
};

export type SchemaSpec = {
	/** Workbook the flows came from, e.g. "TgtSchema_FINFADM_Phase2.xlsx". */
	sourceFile: string;
	/** Target schema this workbook covers, e.g. "FINFADM". */
	schema: string;
	flows: TableFlow[];
	/** Target tables with no mapped column at all - target-only, out of scope. */
	targetOnlyTables: string[];
	/** Rows that could not be read, with the reason. */
	skipped: { cell: string; reason: string }[];
};
