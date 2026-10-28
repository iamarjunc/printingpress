import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMigration, writeMigration } from "../scripts/import-lib.ts";
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_RECORDS,
  prepareImport,
} from "../src/lib/import.ts";

// Fictional fixtures only. Actual business data stays in ignored private files.
const historical = {
  id: "archive-7",
  customer_name: "മാതൃക Test Shop",
  bill_type: "Sample invoice",
  start_no: 701,
  end_no: 1000,
  pages: 30,
  books: 10,
  added_by: "Chandrakumar",
  created_at: "2021-08-01T00:15:10.123456+05:30",
  date_key: "2021-08-01",
  is_legacy: false,
  old_metadata: {
    print_colours: ["white", "yellow"],
    note: "Keep original spelling",
  },
};
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

test("browser import produces exactly the CLI filenames, contents and preserved historical values", async () => {
  const withoutId = { ...historical } as Record<string, unknown>;
  delete withoutId.id;
  const input = [
    historical,
    { ...historical, id: 45, customer_name: "മാതൃക test shop", books: 12 },
    withoutId,
    withoutId,
  ];
  const expected = buildMigration(input);
  const browser = await prepareImport(encode(input));
  assert.deepEqual(browser.entries, expected.entries);
  assert.deepEqual(browser.rejected, expected.rejected);
  assert.deepEqual(browser.warnings, expected.warnings);
  assert.equal(browser.totalBooks, expected.totalBooks);
  assert.equal(browser.uniqueCustomers, expected.uniqueCustomers);
  assert.equal(browser.entries[0].record.created_at, historical.created_at);
  assert.equal(browser.entries[0].record.is_legacy, false);
  assert.deepEqual(
    browser.entries[0].record.old_metadata,
    historical.old_metadata,
  );
  assert.match(browser.entries[0].path, /^records\/2021\/07\//);
});

test("browser report matches the CLI byte for byte and original source backup is exact and first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pressbook-browser-import-"));
  try {
    const source = new TextEncoder().encode(
      `\r\n  ${JSON.stringify([historical], null, 4)}\r\n`,
    );
    const input = join(directory, "legacy.json");
    await writeFile(input, source);
    const cli = await writeMigration(input, join(directory, "output"));
    const prepared = await prepareImport(source);
    assert.deepEqual(prepared.report, cli.report);
    assert.equal(prepared.files[0].path, "backups/legacy_data.json");
    assert.deepEqual(prepared.files[0].bytes, source);
    assert.equal(
      prepared.report.source_sha256,
      createHash("sha256").update(source).digest("hex"),
    );
    const report = prepared.files.find(
      (file) => file.path === "backups/migration-report.json",
    );
    assert.ok(report);
    assert.deepEqual(
      Buffer.from(report.bytes),
      await readFile(join(cli.output, "migration-report.json")),
    );
    assert.equal(
      new TextDecoder().decode(prepared.files[1].bytes),
      cli.plan.entries[0].content,
    );
    source.fill(0);
    assert.deepEqual(Buffer.from(prepared.backupBytes), await readFile(input));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repeated browser preparation is idempotent and retains duplicate historical rows independently", async () => {
  const source = encode([
    historical,
    historical,
    { ...historical, id: "archive-8" },
  ]);
  const first = await prepareImport(source),
    second = await prepareImport(source);
  assert.deepEqual(first.files, second.files);
  assert.equal(first.entries.length, 3);
  assert.equal(new Set(first.entries.map((entry) => entry.path)).size, 3);
  assert.deepEqual(
    first.entries.map((entry) => entry.record.id),
    ["archive-7", "archive-7", "archive-8"],
  );
  assert.equal(first.totalBooks, 30);
  assert.ok(first.warnings.some((warning) => warning.code === "duplicate-id"));
  assert.ok(
    first.warnings.some((warning) => warning.code === "possible-duplicate"),
  );
});

test("missing optional values receive null defaults without replacing original creation timestamps", async () => {
  const {
    id: _id,
    date_key: _date,
    is_legacy: _legacy,
    ...withoutOptional
  } = historical;
  const prepared = await prepareImport(encode([withoutOptional]));
  const record = prepared.entries[0].record;
  assert.match(record.id, /^legacy-[a-f0-9]{16}-1$/);
  assert.equal(record.photo_path, null);
  assert.equal(record.updated_at, null);
  assert.equal(record.created_at, historical.created_at);
  assert.equal(record.date_key, historical.date_key);
  assert.equal(record.is_legacy, true);
});

test("invalid individual rows are reported and unsafe photo paths are never treated as importable", async () => {
  const prepared = await prepareImport(
    encode([
      historical,
      null,
      { ...historical, books: 0 },
      { ...historical, photo_path: "https://outside.invalid/image.png" },
      { ...historical, created_at: "2021-08-01T24:00:00Z" },
    ]),
  );
  assert.equal(prepared.sourceCount, 5);
  assert.equal(prepared.entries.length, 1);
  assert.deepEqual(
    prepared.rejected.map((row) => row.index),
    [2, 3, 4, 5],
  );
  assert.ok(prepared.rejected.every((row) => row.errors.length > 0));
  assert.deepEqual(prepared.report.rejected, prepared.rejected);
  assert.equal(
    prepared.files.filter((file) => file.path.startsWith("records/")).length,
    1,
  );
});

test("invalid UTF-8, malformed JSON and unsupported top-level formats give useful errors", async () => {
  await assert.rejects(prepareImport(new Uint8Array()), /empty/);
  await assert.rejects(
    prepareImport(new Uint8Array([0xff, 0xfe, 0xff])),
    /UTF-8 JSON/,
  );
  await assert.rejects(
    prepareImport(new TextEncoder().encode("[broken")),
    /UTF-8 JSON/,
  );
  await assert.rejects(
    prepareImport(encode({ records: [historical] })),
    /JSON array/,
  );
});

test("browser import bounds source size, row count and excessive review output", async () => {
  await assert.rejects(
    prepareImport(new Uint8Array(MAX_IMPORT_BYTES + 1)),
    /5 MB.*command-line/,
  );
  await assert.rejects(
    prepareImport(encode(new Array(MAX_IMPORT_RECORDS + 1).fill(null))),
    /5,000.*command-line/,
  );
  await assert.rejects(
    prepareImport(encode(new Array(205).fill(historical))),
    /too many overlapping.*command-line/,
  );
});

test("preparing an import never makes network requests", async () => {
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("Unexpected network request");
  };
  try {
    const prepared = await prepareImport(encode([historical]));
    assert.equal(prepared.entries.length, 1);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
