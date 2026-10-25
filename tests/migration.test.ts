import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildMigration, writeMigration } from '../scripts/import-lib.ts';

const historical = {
  id: 'old-3', customer_name: 'കട Sample', bill_type: 'Invoice', start_no: 1, end_no: 500,
  pages: 50, books: 10, added_by: 'Chandrakumar',
  created_at: '2020-01-03T05:35:37.400467+00:00', date_key: '2020-01-03', is_legacy: false,
};

test('migration preserves exact historical timestamps, identifiers, Unicode and legacy flag', () => {
  const plan = buildMigration([historical]);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.rejected.length, 0);
  const record = plan.entries[0].record;
  assert.equal(record.id, historical.id);
  assert.equal(record.created_at, historical.created_at);
  assert.equal(record.customer_name, historical.customer_name);
  assert.equal(record.is_legacy, false);
  assert.equal(record.updated_at, null);
  assert.equal(record.photo_path, null);
  assert.match(plan.entries[0].path, /^records\/2020\/01\/.+\.json$/);
});

test('migration retains apparently duplicate and byte-identical historical rows separately', () => {
  const input = [historical, { ...historical, id: 'old-4' }, historical];
  const plan = buildMigration(input);
  assert.equal(plan.entries.length, 3);
  assert.equal(new Set(plan.entries.map(({ path }) => path)).size, 3);
  assert.equal(plan.entries[2].record.id, historical.id);
  assert.ok(plan.warnings.some(({ code }) => code === 'possible-duplicate'));
  assert.ok(plan.warnings.some(({ code }) => code === 'duplicate-id'));
  assert.deepEqual(plan.entries.map(({ path }) => path), buildMigration(input).entries.map(({ path }) => path));
});

test('migration highlights capitalization and quantities without rewriting original details', () => {
  const unusual = { ...historical, id: 'old-9', customer_name: 'കട sample', books: 80 };
  const plan = buildMigration([historical, unusual]);
  assert.equal(plan.uniqueCustomers, 1);
  assert.equal(plan.entries[1].record.customer_name, unusual.customer_name);
  assert.equal(plan.entries[1].record.books, 80);
  assert.ok(plan.warnings.some(({ code }) => code === 'quantity-review'));
  assert.ok(plan.warnings.some(({ code }) => code === 'customer-spelling'));
});

test('invalid rows are individually reported while valid rows remain importable', () => {
  const plan = buildMigration([historical, null, { ...historical, end_no: 0 }, { ...historical, created_at: '2020-01-03 10:00' }]);
  assert.equal(plan.sourceCount, 4);
  assert.equal(plan.entries.length, 1);
  assert.deepEqual(plan.rejected.map(({ index }) => index), [2, 3, 4]);
  assert.ok(plan.rejected.every(({ errors }) => errors.length));
  assert.throws(() => buildMigration({ records: [] }), /JSON array/);
});

test('missing IDs receive stable IDs without silently merging identical rows', () => {
  const { id: _id, ...withoutId } = historical;
  const first = buildMigration([withoutId, withoutId]);
  const again = buildMigration([withoutId, withoutId]);
  assert.equal(first.entries.length, 2);
  assert.notEqual(first.entries[0].record.id, first.entries[1].record.id);
  assert.deepEqual(first.entries, again.entries);
});

test('filesystem migration is idempotent and backs up original bytes exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pressbook-migration-'));
  try {
    const input = join(root, 'source.json');
    const output = join(root, 'private-output');
    const bytes = `\n${JSON.stringify([historical], null, 4)}\n\n`;
    await writeFile(input, bytes);
    const first = await writeMigration(input, output);
    const second = await writeMigration(input, output);
    assert.equal(first.created, 1);
    assert.equal(first.unchanged, 0);
    assert.equal(second.created, 0);
    assert.equal(second.unchanged, 1);
    assert.equal(await readFile(first.backupPath, 'utf8'), bytes);
    assert.deepEqual(first.report, second.report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('filesystem migration refuses to overwrite a modified destination record or backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pressbook-migration-conflict-'));
  try {
    const input = join(root, 'source.json');
    const output = join(root, 'private-output');
    await writeFile(input, JSON.stringify([historical]));
    const first = await writeMigration(input, output);
    const recordPath = join(output, first.plan.entries[0].path);
    await writeFile(recordPath, 'manually changed');
    await assert.rejects(writeMigration(input, output), /Refusing to overwrite/);
    assert.equal(await readFile(recordPath, 'utf8'), 'manually changed');
    await writeFile(first.backupPath, 'a different original');
    await assert.rejects(writeMigration(input, output), /Refusing to overwrite/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
