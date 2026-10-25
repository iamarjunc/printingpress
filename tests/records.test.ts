import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ADDED_BY, creationTimestamp, customerNames, localDateKey, matchesSearch,
  normalize, parseRecord, recordPath, recordWarnings, safePhotoPath,
  validDateKey, validateRecord, validTimestamp,
} from '../src/lib/records.ts'
import type { PrintingRecord } from '../src/types.ts'

const fixture = (changes: Partial<PrintingRecord> = {}): PrintingRecord => ({
  id: 'test-unique-id', customer_name: 'Harbour Test Supplies', bill_type: 'Sample invoice',
  start_no: 1201, end_no: 1800, pages: 25, books: 30, added_by: 'Sreelekha',
  created_at: '2021-02-17T08:12:45.123456+00:00', updated_at: null,
  date_key: '2021-02-17', photo_path: null, is_legacy: true, ...changes,
})

test('family names and original historical details are preserved exactly', () => {
  assert.deepEqual(ADDED_BY, ['Chandrakumar', 'Sreelekha', 'Appu', 'Akku'])
  const source = fixture({ customer_name: 'Harbour test supplies' })
  const parsed = parseRecord(source)
  assert.deepEqual(parsed, source)
  assert.equal(parsed.created_at, '2021-02-17T08:12:45.123456+00:00')
  const { updated_at: _updated, photo_path: _photo, ...legacy } = source
  assert.deepEqual(parseRecord(legacy), source)
})

test('record validation rejects unsafe and invalid numeric input without changing it', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.ok(validateRecord({ ...fixture(), books: value }).some(error => error.includes('books')))
  }
  assert.ok(validateRecord(fixture({ end_no: 1200 })).some(error => /smaller/.test(error)))
  assert.ok(validateRecord(fixture({ customer_name: '  ' })).some(error => /customer_name/.test(error)))
  assert.deepEqual(validateRecord(fixture()), [])
})

test('dates require a real calendar date and unambiguous timezone', () => {
  assert.equal(validDateKey('2024-02-29'), true)
  assert.equal(validDateKey('2026-02-29'), false)
  assert.equal(validDateKey('2026-13-01'), false)
  assert.equal(validTimestamp('2026-10-25T11:30:00'), false)
  assert.equal(validTimestamp('2026-02-30T11:30:00Z'), false)
  assert.equal(validTimestamp('2026-10-25T11:30:00+05:30'), true)
  assert.equal(validTimestamp('2022-09-06T13:14:15.987654+00:00'), true)
})

test('past diary date uses the device local time and returns a UTC instant', () => {
  const originalTimezone = process.env.TZ
  process.env.TZ = 'Asia/Kolkata'
  try {
    const now = new Date('2026-10-25T06:00:15.123Z')
    assert.equal(localDateKey(now), '2026-10-25')
    assert.equal(creationTimestamp('2021-02-17', now), '2021-02-17T06:00:15.123Z')
    assert.throws(() => creationTimestamp('2026-02-30', now), /valid creation date/)
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ
    else process.env.TZ = originalTimezone
  }
})

test('search handles casing, whitespace, Malayalam and serial numbers inside a range', () => {
  const record = fixture()
  assert.equal(normalize('  HARBOUR   Test Supplies  '), 'harbour test supplies')
  for (const query of ['harbour', 'SAMPLE INVOICE', '1,500', '1201', '1800']) assert.equal(matchesSearch(record, query), true)
  assert.equal(matchesSearch(record, '1200'), false)
  assert.equal(matchesSearch(record, '1801'), false)
  assert.equal(matchesSearch(fixture({ customer_name: 'ശ്രീ പ്രിന്റേഴ്സ്' }), 'ശ്രീ'), true)
  const names = customerNames([record, fixture({ customer_name: 'Harbour test supplies' }), fixture({ customer_name: 'Other customer' })])
  assert.equal(names.length, 2)
  assert.equal(names.includes('Harbour Test Supplies'), true)
})

test('unusual book counts and overlapping historical ranges warn without altering values', () => {
  const record = fixture()
  const original = structuredClone(record)
  const warnings = recordWarnings(record, [fixture({ id: 'different-record', customer_name: 'HARBOUR TEST SUPPLIES' })])
  assert.ok(warnings.some(warning => /pages.*books/.test(warning)))
  assert.ok(warnings.some(warning => /duplicate|reprint/.test(warning)))
  assert.deepEqual(record, original)
  const otherType = fixture({ id: 'other-type', bill_type: 'Receipt' })
  assert.equal(recordWarnings(fixture({ books: 24 }), [otherType]).length, 0)
  const partial = fixture({ id: 'partial', start_no: 1750, end_no: 1950 })
  assert.ok(recordWarnings(record, [partial]).some(warning => /overlaps/.test(warning)))
})

test('photo paths cannot point to remote URLs, traversal, or executable content', () => {
  assert.equal(safePhotoPath('images/2026/10/record-uuid.jpg'), true)
  assert.equal(safePhotoPath('images/2026/10/record-uuid.webp'), true)
  for (const path of ['https://attacker.test/photo.jpg', '../images/a/b/photo.jpg', 'images/2026/10/../../secret.jpg', 'images/2026/10/photo.svg', 'records/2026/10/photo.jpg']) {
    assert.equal(safePhotoPath(path), false)
    assert.ok(validateRecord(fixture({ photo_path: path })).some(error => /photo_path/.test(error)))
  }
})

test('a retried create targets the same collision-resistant safe record path', () => {
  const record = fixture({ id: '47e0b065-2be5-4ebf-9890-79f972176bad' })
  const path = recordPath(record)
  assert.equal(path, recordPath(structuredClone(record)))
  assert.match(path, /^records\/2021\/02\/2021-02-17T08-12-45\.123Z_47e0b065-2be5-4ebf-9890-79f972176bad\.json$/)
  assert.notEqual(path, recordPath(fixture({ id: 'a-different-uuid' })))
  assert.equal(recordPath(fixture({ id: '../unsafe/id' })).includes('..'), false)
})

test('CSV export preserves Malayalam and quotes while neutralizing spreadsheet formulas', async () => {
  const { recordsCsv } = await import('../src/lib/export.ts')
  const source = fixture({ customer_name: 'ശ്രീ, "Printers"\nKerala', bill_type: '=HYPERLINK("https://example.test")' })
  const csv = recordsCsv([source])
  assert.equal(csv.startsWith('\uFEFFid,customer_name,'), true)
  assert.ok(csv.includes('"ശ്രീ, ""Printers""\nKerala"'))
  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.test"")"'))
  assert.equal(source.bill_type, '=HYPERLINK("https://example.test")')
})
