# finaqua-ide-template-migration

Generates **node-red flows** for the Oracle → Postgres migration from the
`TgtSchema_<SCHEMA>_Phase2.xlsx` mapping workbooks.

The migration is **one source table → one target table**. Every mapped column
keeps its name (only 5 of 38,999 are renamed) and changes only case and type, so
there is no transformation language here — the work is scope, types and keys.

## Scope

This plugin's output is `node-red-flows.json`, and that is where it stops.

```
TgtSchema_*.xlsx ──┐
                   ├─▶ generate ─▶ <dest>/<SCHEMA>/node-red-flows.json   ← the deliverable
index/ (the keys) ─┘                             server.json
                                                 coverage.md
```

Compiling those flows into finaqua batch job configs and NiFi process groups is
`aqua-flowbuilder`'s job, run separately. This tool never invokes it, and the
flows it writes are plain Node-RED JSON using aqua node types — openable in the
Node-RED editor, and consumable by whatever runs next.

For a step-by-step walkthrough aimed at whoever runs this rather than maintains
it, see [docs/USER-GUIDE.md](docs/USER-GUIDE.md).

## Usage

### 1. Install

```bash
pnpm install
```

### 2. Look before generating

```bash
pnpm run schema ../migrationTemplate
```

One line per schema — tables, columns, renames, target-only columns, and how many
tables can be written idempotently:

```
SCHEMA        TABLES  COLUMNS  RENAMED  TGT-ONLY  UPSERT  BLOCKED
-----------------------------------------------------------------
ACADM             58     1485        0       136      58        0
FINFADM           29      412        0         6      28        1
LAADM            171     4387        0       384     168        3
LMADM              5      112        5       314       1        4
TBAADM           990    32603        0      4812     963       27
-----------------------------------------------------------------
TOTAL           1253    38999        5      5652    1218       35
```

To see one table's SQL before committing to a run:

```bash
pnpm run schema ../migrationTemplate --table LM_INT_ALLOC_TABLE
```

pnpm passes arguments straight through, so there is no `--` separator — adding
one makes commander treat it as a positional and the command fails.

### 3. Generate the flows

```bash
pnpm run generate ../migrationTemplate ./out --keys ../migrationTemplate/index
```

`generate` is the default command, so `tsx src/index.ts ../migrationTemplate ./out` does
the same thing. Output, one bundle per target schema:

```
out/
  LMADM/
    node-red-flows.json    one tab per table, aqua node types
    server.json            every ${PLACEHOLDER} the flow uses, blank
    coverage.md            what was generated, excluded, and blocked
  TBAADM/
  …
```

One bundle per schema rather than one file: all 1,253 tables together would be
roughly 25,000 nodes, which no Node-RED editor will open comfortably.

`--keys` is optional but **strongly recommended** — see *Idempotency* below.

## What a generated tab looks like

```
aqua_batch_sql_event ──▶ aqua_procedure ──▶ aqua_action_write_gold
   reads the view                              JDBCExecutorSaver
                                               action = upsert | insert
```

with the extraction SQL on the view:

```sql
SELECT SRC.SRL_NUM AS SRL_NUM,
       SRC.BANK_ID AS BANK_ID,
       SRC.INT_FROM_DATE AS INT_FROM_DATE,
       …
       SRC.DEBIT_ACCT AS DEBIT_ENTITY_ID,      -- one of the five renames
       …
FROM TBAADM.LM_INT_ALLOC_TABLE SRC
${LM_INT_ALLOC_TABLE_TO_LM_INT_ALLOC_TABLE_WHERE_CLAUSE}
```

The SQL runs **on the source database**, so it stays Oracle — no dialect
translation anywhere in this path. The projection is aliased to the target column
names, so nothing downstream has to re-map.

Connection details and row filters are never written into the flows, only
placeholder names. `server.json` lists them all, blank, for whoever deploys:

```json
{
  "placeholders": {
    "SRC_DB_URL": "", "SRC_DB_DRIVER": "", "SRC_DB_USERNAME": "", "SRC_DB_PASSWORD": "",
    "TGT_DB_URL": "", "TGT_DB_DRIVER": "", "TGT_DB_USERNAME": "", "TGT_DB_PASSWORD": "",
    "ERROR_DB_URL": "", "ERROR_KAFKA_HOST": "", "ERROR_KAFKA_PORT": "",
    "LM_INT_ALLOC_TABLE_TO_LM_INT_ALLOC_TABLE_WHERE_CLAUSE": ""
  }
}
```

## Idempotency — the index files

The brief requires re-runnable loads: a second run must not duplicate rows. That
needs a unique key per target table, taken from the index exports in
`../migrationTemplate/index`. Point `--keys` at the folder and all seven files
are read together.

Two export shapes are handled:

```
*_key_constraint.csv   schema_name, table_name, constraint_name, constraint_type, key_columns
*_unique_index.csv     schema_name, table_name, index_name, constraint_type, definition
```

For `*_unique_index.csv` the columns are lifted out of the `CREATE UNIQUE INDEX
… USING btree (a, b, c)` statement. `FOREIGN KEY` rows are ignored - a foreign
key is not unique, and upserting on one would collapse every child row onto its
parent. Where a table has several unique indexes, the primary key wins, then the
narrowest key, then name order, so the choice is stable across runs.

A hand-written sheet and a JSON map also work, for a key supplied by hand:

```csv
Target Schema,Target Table,Column Name,Ordinal
LMADM,LM_INT_ALLOC_TABLE,SRL_NUM,1
LMADM,LM_INT_ALLOC_TABLE,BANK_ID,2
```

```json
{ "LMADM.LM_INT_ALLOC_TABLE": ["SRL_NUM", "BANK_ID"] }
```

Header spellings are matched loosely (`table_schema` / `Target Schema` / `owner`,
`column_name` / `Column Name` / `key column`), and `Ordinal` fixes composite key
column order — an upsert matches on the key **in order**, so a shuffled export
must not silently produce a different key.

With a key the table is written as `action: "upsert"`. **Without one it falls
back to `insert` and is listed under "Blocked" in `coverage.md`** — reported
rather than hidden, because a plain-insert re-run is precisely the duplicate-row
failure the requirement exists to prevent.

A key naming a column the mapping never produces is also caught and downgraded,
since upserting on an absent column would match nothing and insert duplicates.

## Scope rules

Taken from the migration brief and enforced by the parser:

| Rule | Behaviour |
|---|---|
| Migrate only tables mapped on **both** sides | 1,253 tables in scope |
| Target-only tables are out of scope | 1,088 tables excluded |
| `Action = "New Column"` marks a target-only column | 5,652 columns excluded, counted in `coverage.md` |
| Never modify, rename or alter target tables | `tableCreationMode: "none"`, `truncateTable: "false"` |
| Row filters are a deployment decision | left as `${..._WHERE_CLAUSE}` |

## Commands

| Command | What it does |
|---|---|
| `pnpm run schema <src>` | Parse and report; `--table <name>` prints one table's SQL |
| `pnpm run generate <src> <dest>` | Write the flows; `--keys <file>` enables upsert |
| `pnpm run typecheck` | `tsc --noEmit` |
| `pnpm test` | `node:test` via tsx |
| `pnpm run check` | Biome lint + format; `check:apply` writes fixes |
| `pnpm run build` | tsup → `dist/index.js` |

## Layout

```
src/
  SchemaMapping/
    index.ts      workbook   → TableFlow[]
    generate.ts   TableFlow  → extraction SQL + write mode
    nodered.ts    TableFlow  → node-red tab
    keys.ts       index file → table → key columns
    emit.ts       writes flows, server.json, coverage.md
    cells.ts      ExcelJS helpers
    types.ts
  index.ts        CLI
  utils.ts        path resolution
```

Node ids are **deterministic** — derived from `sha256(tab|role|ordinal)` rather
than randomly generated — so regenerating an unchanged workbook produces a
byte-identical file. With random ids every regeneration rewrites all 1,253 tabs
and a real mapping change is impossible to spot in a diff.

## Known gaps

- **35 tables cannot yet be made idempotent.** 7 have no entry in the index
  exports; 28 have a unique key whose columns the mapping does not migrate - for
  example `tbaadm.free_code_free_text_table` keys on `b2k_type, b2k_id`, neither
  of which is mapped. Each is listed by name in its schema's `coverage.md`.
  4 of LMADM's 5 tables key on `lm_link_id`, which the mapping never produces.
- **The Postgres → aqua type map** (`nodered.ts`) is derived from the column types
  in the workbooks and has not been verified against the aqua Java runtime.
  Unknown types fall back to `string`.
- **Five renames in LMADM** are semantic, not cosmetic — `TO_ACCT_ID →
  LINKED_TO_ENTITY_ID`, `DEBIT_ACCT → DEBIT_ENTITY_ID` and three more. They are
  generated as straight copies; if account ids and entity ids are different value
  spaces these need a lookup instead. Listed in each `coverage.md`.
- **The repository has no commits yet** (branch `master`; the FDL repo uses
  `main`). Worth an initial commit — nothing here is currently recoverable.

## Out of scope

Deliberately not implemented, and not present in the code:

- **CDH (CRMUSER → CIF)** multi-cardinality mapping — 1-M, M-1, M-M.
- **The Collaterals SQL → REST API flow**, where the target is a `POST` whose
  JSON body is built from the result columns, including nested arrays.
- **Compiling flows into finaqua job configs** — that is `aqua-flowbuilder`'s job.
