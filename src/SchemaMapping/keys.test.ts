import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadKeys } from "@/SchemaMapping/keys.js";

async function withFile(name: string, body: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "keys-"));
	const file = path.join(dir, name);
	await writeFile(file, body, "utf8");
	return file;
}

test("csv keys are grouped by table", async () => {
	const file = await withFile(
		"index.csv",
		[
			"Target Schema,Target Table,Column Name,Ordinal",
			"LMADM,LM_INT_ALLOC_TABLE,SRL_NUM,1",
			"LMADM,LM_INT_ALLOC_TABLE,BANK_ID,2",
			"LMADM,LM_RESET_TABLE,ID,1",
		].join("\n"),
	);

	const keys = await loadKeys(file);
	assert.deepEqual(keys.get("lmadm.lm_int_alloc_table"), [
		"SRL_NUM",
		"BANK_ID",
	]);
	assert.deepEqual(keys.get("lmadm.lm_reset_table"), ["ID"]);
});

test("composite key column order follows the ordinal, not the file order", async () => {
	// An upsert matches on the key in order, so a shuffled export must not
	// silently produce a different key.
	const file = await withFile(
		"index.csv",
		[
			"Target Schema,Target Table,Column Name,Ordinal",
			"LMADM,T,SECOND,2",
			"LMADM,T,FIRST,1",
		].join("\n"),
	);

	assert.deepEqual((await loadKeys(file)).get("lmadm.t"), ["FIRST", "SECOND"]);
});

test("alternative header spellings are accepted", async () => {
	const file = await withFile(
		"index.csv",
		["table_schema,table_name,column_name", "acadm,SI_HEADER_TABLE,SI_ID"].join(
			"\n",
		),
	);

	assert.deepEqual((await loadKeys(file)).get("acadm.si_header_table"), [
		"SI_ID",
	]);
});

test("a repeated column is not added twice", async () => {
	const file = await withFile(
		"index.csv",
		[
			"Target Schema,Target Table,Column Name",
			"LMADM,T,ID",
			"LMADM,T,id",
			"LMADM,T,OTHER",
		].join("\n"),
	);

	assert.deepEqual((await loadKeys(file)).get("lmadm.t"), ["ID", "OTHER"]);
});

test("quoted csv fields survive an embedded comma", async () => {
	const file = await withFile(
		"index.csv",
		["Target Schema,Target Table,Column Name", 'LMADM,"T,WITH,COMMAS",ID'].join(
			"\n",
		),
	);

	assert.deepEqual((await loadKeys(file)).get("lmadm.t,with,commas"), ["ID"]);
});

test("json keys load directly", async () => {
	const file = await withFile(
		"index.json",
		JSON.stringify({ "LMADM.LM_INT_ALLOC_TABLE": ["SRL_NUM", "BANK_ID"] }),
	);

	assert.deepEqual((await loadKeys(file)).get("lmadm.lm_int_alloc_table"), [
		"SRL_NUM",
		"BANK_ID",
	]);
});

test("an index file with only a header yields no keys", async () => {
	const file = await withFile(
		"index.csv",
		"Target Schema,Target Table,Column Name",
	);
	assert.equal((await loadKeys(file)).size, 0);
});
