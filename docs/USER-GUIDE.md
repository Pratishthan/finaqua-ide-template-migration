# Migration template — user guide

How to turn the mapping spreadsheets into node-red flows, from scratch, without
needing to read any code.

If you only want the short version: **put the spreadsheets in a folder, run two
commands, read `coverage.md`, hand `node-red-flows.json` to the team that
deploys it.**

---

## What this tool does

The migration is defined in spreadsheets. Somebody has written down, for every
table, which source column becomes which target column. That is thousands of
rows — 38,999 of them — and turning each one into a flow by hand is not
realistic.

This tool reads those spreadsheets and writes the flows for you.

```
   the spreadsheets                    what you get
   ────────────────                    ────────────
   TgtSchema_ACADM_Phase2.xlsx         one node-red flow per table
   TgtSchema_FINFADM_Phase2.xlsx  ──▶  a list of settings to fill in
   TgtSchema_LAADM_Phase2.xlsx         a report of what it could and
   TgtSchema_LMADM_Phase2.xlsx         could not do
   TgtSchema_TBAADM_Phase2.xlsx
```

**What it does not do.** It does not connect to any database, it does not move
any data, and it does not run the migration. It only writes the flow files. A
separate team takes those files and deploys them.

---

## Before you start

You need three things.

**1. Node.js and pnpm on your machine.** Check with:

```bash
node --version     # 20 or newer
pnpm --version
```

If `pnpm` is missing: `npm install -g pnpm`

**2. The mapping spreadsheets**, all in one folder. On this machine they live in
`../migrationTemplate/` — that is, `/Users/aayushsingh/drop/migrationTemplate`,
alongside the tool's own folder:

```
drop/
   finaqua-ide-template-migration/   ← the tool; run commands from here
   migrationTemplate/                ← the five spreadsheets
      TgtSchema_ACADM_Phase2.xlsx
      TgtSchema_FINFADM_Phase2.xlsx
      TgtSchema_LAADM_Phase2.xlsx
      TgtSchema_LMADM_Phase2.xlsx
      TgtSchema_TBAADM_Phase2.xlsx
```

Every command below is run from inside `finaqua-ide-template-migration`, which is
why the spreadsheets are `../migrationTemplate`.

**3. The index files** — the unique key of each target table, exported from the
target database. These live in `../migrationTemplate/index/`, one file per
schema:

```
migrationTemplate/index/
   acadm_unique_index.csv
   finfadm_key_constraint.csv
   laadm_unique_index.csv
   lmadm_unique_index.csv
   tbaadm_unique_index.csv
   custom_key_constraint.csv      (CUSTOM schema, not used by these five)
   custom_unique_index.csv
```

You point at the **folder**, not a single file — all of them are read together.
See *Why the index files matter* below.

---

## Step 1 — Set up, once

```bash
cd finaqua-ide-template-migration
pnpm install
```

You only ever do this once, or after someone updates the tool.

---

## Step 2 — Look before you generate

```bash
pnpm run schema ../migrationTemplate
```

You get one line per spreadsheet:

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

1088 target-only tables excluded (no source mapping)
```

Reading it:

| Column | Meaning |
|---|---|
| **TABLES** | Tables that will get a flow |
| **COLUMNS** | Columns being copied |
| **RENAMED** | Columns whose name changes between source and target — **always check these** |
| **TGT-ONLY** | Target columns with no source. Left empty; out of scope by decision |
| **UPSERT** | Tables safe to re-run |
| **BLOCKED** | Tables that would duplicate rows if re-run — because no key is known |

**Do the numbers look right?** If a schema you expected is missing, or a table
count is far off, stop here and check the spreadsheet rather than generating from
it.

### Looking at a single table

```bash
pnpm run schema ../migrationTemplate --table LM_INT_ALLOC_TABLE
```

```
TBAADM.LM_INT_ALLOC_TABLE->LMADM.LM_INT_ALLOC_TABLE
==============================================================================
columns    19 mapped, 0 target-only (excluded)
write      insert

SELECT SRC.SRL_NUM AS SRL_NUM,
       SRC.DEBIT_ACCT AS DEBIT_ENTITY_ID,
       …
FROM TBAADM.LM_INT_ALLOC_TABLE SRC
${LM_INT_ALLOC_TABLE_TO_LM_INT_ALLOC_TABLE_WHERE_CLAUSE}
```

This is the query that will read the source table. Useful when someone asks
"where exactly does this column come from?"

---

## Step 3 — Generate the flows

```bash
pnpm run generate ../migrationTemplate ./out --keys ../migrationTemplate/index
```

Three things go in: the spreadsheet folder, where to put the output, and the
folder of index files. That last part is what makes the load re-runnable, so
include it.

Leaving it off still generates everything, but every table is marked **Blocked**
— meaning it would duplicate rows if run a second time:

```bash
pnpm run generate ../migrationTemplate ./out      # no keys: all 1,253 blocked
```

You get:

```
./out/
   LMADM/
      node-red-flows.json    ← the deliverable
      server.json            ← settings someone must fill in
      coverage.md            ← the report you read
   TBAADM/
   ACADM/
   …
```

One folder per schema, because putting all 1,253 tables in one file would make
it too large to open.

---

## Step 4 — Read `coverage.md`

**This is the step not to skip.** It is the record of what the tool did, and it
is what you would show someone who asks whether the migration is complete.

```markdown
# LMADM - migration coverage

- tables generated: 5
- columns mapped: 112
- target-only columns excluded: 314
- renamed columns: 5
- tables written as UPSERT: 1
- tables blocked (no key): 4
- target-only tables excluded: 36
```

Then three lists.

**Renamed columns** — every column whose name changes, with the exact
spreadsheet cell:

```
| table                 | source column    | target column         | cell          |
| LM_GROUP_MAINT_TABLE  | TO_ACCT_ID       | LINKED_TO_ENTITY_ID   | Mapping!G184  |
```

Take these to whoever wrote the spreadsheet. A rename like `TO_ACCT_ID →
LINKED_TO_ENTITY_ID` might be a tidy-up, or it might mean an account id is
becoming an entity id — a different kind of value entirely. The tool copies the
value across unchanged; if that is wrong, only a person can say so.

**Blocked** — tables that will duplicate rows if the migration is run twice.
Fix by adding their keys to the index exports, or by supplying a key by hand.

**Excluded** — target tables with no source mapping at all, listed by name so
you can confirm each was meant to be left out.

---

## Step 5 — Hand over

Give the deploy team the whole `out/` folder. They will:

- fill in the blanks in `server.json` — database addresses, usernames, passwords,
  and any row filters
- compile the flows into runnable jobs with a separate tool
  (`aqua-flowbuilder`)
- run them

**Passwords are never written into these files.** `server.json` contains only the
*names* of the settings, all blank:

```json
{
  "placeholders": {
    "SRC_DB_URL": "", "SRC_DB_USERNAME": "", "SRC_DB_PASSWORD": "",
    "TGT_DB_URL": "", "TGT_DB_USERNAME": "", "TGT_DB_PASSWORD": "",
    "LM_INT_ALLOC_TABLE_TO_LM_INT_ALLOC_TABLE_WHERE_CLAUSE": ""
  }
}
```

The `..._WHERE_CLAUSE` entries decide **which rows** get migrated. Left blank,
every row goes. If the migration should only cover, say, one bank or active
records only, that condition goes here — and it is a business decision, not a
technical one.

---

## Why the index files matter

Without them, a table is loaded with plain inserts. Run the migration twice — after
a failure, say, or a re-test — and every row is inserted twice.

With them, the table is loaded with an **upsert**: a row that is already there gets
updated instead of duplicated. The migration becomes safe to re-run.

The exports in `../migrationTemplate/index/` carry each target table's unique
key, either as a column list or inside a `CREATE UNIQUE INDEX` statement. You do
not need to edit them — point at the folder and all seven are read together.

If you ever need to supply a key by hand, a simple sheet works too and can sit
alongside the exports:

```csv
Target Schema,Target Table,Column Name,Ordinal
LMADM,LM_INT_ALLOC_TABLE,SRL_NUM,1
LMADM,LM_INT_ALLOC_TABLE,BANK_ID,2
```

- one row per key column
- `Ordinal` is the order of columns within a key, when a key has more than one
- Excel (`.xlsx`) and JSON work too; the column headings can be named a few
  different ways

### What is already covered

Running against the real index folder, 1,218 of 1,253 tables get a key and become
re-runnable. The remaining **35 are blocked**, for two different reasons, and each
is named in its schema's `coverage.md`:

**7 tables have no entry in the index exports.** The target database has no unique
constraint on them at all. Nothing to do here until somebody defines one — the
brief already says these are handled separately.

**28 tables have a key the migration cannot supply.** The target's unique key
includes a column that is not in the mapping spreadsheet. For example:

```
tbaadm.free_code_free_text_table   key = b2k_type, b2k_id, bank_id
                                   not migrated: b2k_type, b2k_id
```

These need a decision from whoever owns the mapping: either add the missing
columns to the spreadsheet, or nominate a different unique key made of columns
that are migrated. **LMADM is the clearest case** — 4 of its 5 tables key on
`lm_link_id`, which the mapping never produces, and LMADM is also the schema with
all five renamed columns. That sheet is worth a second look.

If you need to supply a key by hand for one of these, a simple sheet works and
can sit alongside the exports:

```csv
Target Schema,Target Table,Column Name,Ordinal
LMADM,LM_INT_ALLOC_TABLE,SRL_NUM,1
LMADM,LM_INT_ALLOC_TABLE,BANK_ID,2
```

If they would rather query the database than fill in a spreadsheet, this returns
the same thing:

```sql
SELECT tc.table_schema  AS "Target Schema",
       tc.table_name    AS "Target Table",
       kcu.column_name  AS "Column Name",
       kcu.ordinal_position AS "Ordinal"
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name
 AND kcu.table_schema    = tc.table_schema
WHERE tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
  AND tc.table_schema IN ('laadm','tbaadm','acadm','lmadm','finfadm')
ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position;
```

Tables missing from this file still generate — they are just listed as
**Blocked** so nobody deploys them by accident believing they are re-runnable.

---

## Everyday questions

**I changed the spreadsheet. What now?**
Re-run step 3. The tool is deterministic — an unchanged spreadsheet produces a
byte-for-byte identical file, so any difference you see in the output is a real
consequence of your edit.

**A table I expected is missing.**
Check `coverage.md` under *Excluded*. A table with no source column mapped
anywhere is treated as out of scope.

**Some columns are not in the flow.**
Columns marked `New Column` in the spreadsheet exist only on the target side and
have nothing to copy from. They are counted as *target-only* and left for the
target database to default.

**Can I generate just one schema?**
Yes — point at the single file:

```bash
pnpm run generate ../migrationTemplate/TgtSchema_LMADM_Phase2.xlsx ./out
```

**Does this move any data?**
No. It writes flow files. Nothing touches a database until the deploy team runs
the generated jobs.

**Something failed and I do not understand the message.**
Copy the whole command and its output to the engineering team. The tool reports
the exact spreadsheet cell — like `Mapping!G184` — whenever a problem comes from
the data.

---

## Checklist

```
[ ] pnpm install                       (once)
[ ] spreadsheets in one folder
[ ] index folder present               ../migrationTemplate/index
[ ] pnpm run schema <folder>           numbers look right?
[ ] pnpm run generate <folder> <out> --keys <index>
[ ] read coverage.md for every schema
[ ] renamed columns confirmed with the mapping author
[ ] blocked tables understood
[ ] hand out/ to the deploy team
```
