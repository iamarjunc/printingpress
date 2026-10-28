import assert from 'node:assert/strict'
import test from 'node:test'
import { GitHubClient, GitHubError } from '../src/lib/github.ts'
import type { PrintingRecord } from '../src/types.ts'

const config = { owner: 'family', repo: 'private-records', branch: 'main', token: 'fictional-import-test-token' }
const prefix = '/repos/family/private-records'
const head = 'a'.repeat(40), tree = 'b'.repeat(40)
const encoder = new TextEncoder()
const record = (changes: Partial<PrintingRecord> = {}): PrintingRecord => ({
  id: 'fictional-legacy-1', customer_name: 'ദീപം ടെസ്റ്റ്', bill_type: 'Sample receipt',
  start_no: 101, end_no: 700, pages: 60, books: 10, added_by: 'Akku',
  created_at: '2020-02-20T08:09:10.123456+00:00', updated_at: null,
  date_key: '2020-02-20', photo_path: null, is_legacy: true, ...changes,
})
const recordFile = (suffix = 'one', changes: Partial<PrintingRecord> = {}) => ({
  path: `records/2020/02/2020-02-20T08-09-10-123Z_legacy-${suffix}.json`,
  bytes: encoder.encode(JSON.stringify(record(changes), null, 2) + '\n'),
})
const backupFile = () => ({ path: 'backups/legacy_data.json', bytes: encoder.encode(JSON.stringify([record()], null, 2) + '\n') })
const reportFile = () => ({ path: 'backups/migration-report.json', bytes: encoder.encode(JSON.stringify({ source_count: 1, imported_count: 1, warnings: [] }, null, 2) + '\n') })
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
type Call = { url: URL; method: string; body: Record<string, unknown>; signal?: AbortSignal }
type RemoteFile = { bytes: Uint8Array; sha: string }

async function usingFetch<T>(handler: (call: Call) => Response | Promise<Response>, action: (calls: Call[]) => Promise<T>): Promise<T> {
  const previous = globalThis.fetch
  const calls: Call[] = []
  let mockFailure: unknown
  globalThis.fetch = async (input, init) => {
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const headers = new Headers(init?.headers)
      assert.equal(url.origin, 'https://api.github.com')
      assert.ok(url.pathname.startsWith(prefix))
      assert.equal(url.href.includes(config.token), false)
      assert.equal(headers.get('authorization'), `Bearer ${config.token}`)
      const call = { url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : {}, signal: init?.signal ?? undefined }
      calls.push(call)
      return await handler(call)
    } catch (error) {
      // Only a deliberate TypeError represents a network interruption. Keep mock
      // assertion failures separate so production network wrapping cannot hide them.
      if (!(error instanceof TypeError)) mockFailure = error
      throw error
    }
  }
  try { return await action(calls) } finally {
    globalThis.fetch = previous
    if (mockFailure) throw mockFailure
  }
}

function remote() {
  const files = new Map<string, RemoteFile>()
  let revision = 1
  const sha = () => (revision++).toString(16).padStart(40, '0')
  const put = (path: string, bytes: Uint8Array) => { const next = { bytes: new Uint8Array(bytes), sha: sha() }; files.set(path, next); return next }
  const respond = (call: Call): Response => {
    const path = decodeURIComponent(call.url.pathname.slice(prefix.length))
    if (path === '') return jsonResponse({ private: true, permissions: { push: true } })
    if (path === '/commits/main') return jsonResponse({ sha: head, commit: { tree: { sha: tree } } })
    if (path.startsWith('/git/blobs/')) {
      const file = [...files.values()].find(entry => entry.sha === path.slice('/git/blobs/'.length))
      assert.ok(file, 'blob must exist in the fictional repository')
      return jsonResponse({ encoding: 'base64', content: Buffer.from(file.bytes).toString('base64') })
    }
    if (path.startsWith('/contents/')) {
      const name = path.slice('/contents/'.length), current = files.get(name)
      if (call.method === 'GET') {
        assert.equal(call.url.searchParams.get('ref'), 'main')
        return current ? jsonResponse({ type: 'file', sha: current.sha, path: name, encoding: 'base64', content: Buffer.from(current.bytes).toString('base64') }) : jsonResponse({ message: 'Not Found' }, 404)
      }
      assert.equal(call.method, 'PUT')
      assert.equal(call.body.branch, 'main')
      assert.equal(call.body.sha, undefined, 'import must never use an overwrite SHA')
      if (current) return jsonResponse({ message: 'sha is required' }, 422)
      const next = put(name, Buffer.from(String(call.body.content), 'base64'))
      return jsonResponse({ commit: { sha: sha() }, content: { sha: next.sha, path: name } }, 201)
    }
    throw new Error(`Unexpected mock endpoint: ${call.method} ${path}`)
  }
  return { files, put, respond }
}

function assertProgress(error: unknown, expected: { uploaded: number; skipped: number; total: number; path?: string }) {
  assert.ok(error instanceof GitHubError)
  assert.deepEqual(error.importProgress, expected)
  return true
}

test('browser import refuses a public repository before any record or backup write', async () => {
  await usingFetch(call => {
    assert.equal(call.url.pathname, prefix)
    return jsonResponse({ private: false, permissions: { push: true } })
  }, async calls => {
    await assert.rejects(new GitHubClient(config).importFiles([recordFile()]), /private/i)
    assert.equal(calls.length, 1)
    assert.equal(calls.some(call => call.method === 'PUT'), false)
  })
})

test('browser import preserves exact historical UTF-8 bytes and skips an identical repeated import', async () => {
  const api = remote(), files = [recordFile(), backupFile(), reportFile()]
  const progress: number[][] = []
  await usingFetch(api.respond, async calls => {
    const client = new GitHubClient(config)
    assert.deepEqual(await client.importFiles(files, (...value) => progress.push(value)), { uploaded: 3, skipped: 0 })
    for (const file of files) assert.deepEqual(api.files.get(file.path)!.bytes, file.bytes)
    const imported = JSON.parse(new TextDecoder().decode(api.files.get(files[0].path)!.bytes))
    assert.equal(imported.created_at, '2020-02-20T08:09:10.123456+00:00')
    assert.equal(imported.customer_name, 'ദീപം ടെസ്റ്റ്')
    assert.equal(imported.is_legacy, true)
    assert.deepEqual(progress.at(-1), [3, 3, 0])
    const writesBefore = calls.filter(call => call.method === 'PUT').length
    assert.deepEqual(await client.importFiles(files), { uploaded: 0, skipped: 3 })
    assert.equal(calls.filter(call => call.method === 'PUT').length, writesBefore)
  })
})

test('browser import never overwrites different content at a deterministic historical path', async () => {
  const api = remote(), file = recordFile()
  const previous = recordFile('one', { books: 11 }).bytes
  api.put(file.path, previous)
  await usingFetch(api.respond, async calls => {
    await assert.rejects(new GitHubClient(config).importFiles([file]), error => {
      assert.ok(error instanceof GitHubError)
      assert.equal(error.kind, 'conflict')
      return assertProgress(error, { uploaded: 0, skipped: 0, total: 1, path: file.path })
    })
    assert.equal(calls.some(call => call.method === 'PUT'), false)
    assert.deepEqual(api.files.get(file.path)!.bytes, previous)
  })
})

test('browser import does not report a saved file without complete GitHub commit confirmation', async () => {
  const api = remote(), file = recordFile()
  await usingFetch(call => call.method === 'PUT' ? jsonResponse({ content: { sha: 'c'.repeat(40), path: file.path } }, 201) : api.respond(call), async () => {
    await assert.rejects(new GitHubClient(config).importFiles([file]), error => {
      assert.ok(error instanceof GitHubError)
      assert.equal(error.kind, 'uncertain')
      assert.match(error.message, /confirm|commit|retry|rerun/i)
      return assertProgress(error, { uploaded: 0, skipped: 0, total: 1, path: file.path })
    })
  })
})

test('an interrupted import resumes by reading the already committed bytes rather than creating duplicates', async () => {
  const api = remote(), files = [recordFile('one'), recordFile('two', { id: 'fictional-legacy-2' })]
  let loseFirstResponse = true
  await usingFetch(call => {
    const response = api.respond(call)
    if (call.method === 'PUT' && loseFirstResponse) { loseFirstResponse = false; throw new TypeError('Fictional interrupted connection') }
    return response
  }, async calls => {
    const client = new GitHubClient(config)
    await assert.rejects(client.importFiles(files), error => assertProgress(error, { uploaded: 0, skipped: 0, total: 2, path: files[0].path }))
    assert.equal(api.files.size, 1)
    assert.deepEqual(await client.importFiles(files), { uploaded: 1, skipped: 1 })
    assert.equal(api.files.size, 2)
    assert.equal(calls.filter(call => call.method === 'PUT' && decodeURIComponent(call.url.pathname).endsWith(files[0].path)).length, 1)
  })
})

test('unsafe paths, duplicate destinations and invalid records fail before authenticated network access', async () => {
  await usingFetch(() => { throw new Error('Invalid imports must not reach the network') }, async calls => {
    const client = new GitHubClient(config), valid = recordFile()
    for (const path of ['records/2020/02/../outside.json', 'public/records.json', 'records/2020/13/invalid.json', 'backups/other.json']) {
      await assert.rejects(client.importFiles([{ ...valid, path }]), /path|destination|invalid|refus/i)
    }
    await assert.rejects(client.importFiles([valid, valid]), /duplicate|same|unique/i)
    await assert.rejects(client.importFiles([{ path: valid.path, bytes: encoder.encode(JSON.stringify(record({ end_no: 1 }))) }]), /end|range|invalid/i)
    assert.equal(calls.length, 0)
  })
})

test('a missing or inaccessible branch is not treated as permission to create missing record files', async () => {
  await usingFetch(call => {
    if (call.url.pathname === prefix) return jsonResponse({ private: true })
    assert.equal(call.url.pathname, `${prefix}/commits/main`)
    return jsonResponse({ message: 'Not Found' }, 404)
  }, async calls => {
    await assert.rejects(new GitHubClient(config).importFiles([recordFile()]), (error: unknown) => error instanceof GitHubError && error.status === 404)
    assert.equal(calls.some(call => call.url.pathname.includes('/contents/')), false)
    assert.equal(calls.some(call => call.method === 'PUT'), false)
  })
})

test('partial import failures report only confirmed progress and retain the first completed file', async () => {
  const api = remote(), files = [recordFile('one'), recordFile('two', { id: 'fictional-legacy-2' })], progress: number[][] = []
  await usingFetch(call => call.method === 'PUT' && decodeURIComponent(call.url.pathname).endsWith(files[1].path) ? jsonResponse({ message: 'Resource not accessible' }, 403) : api.respond(call), async () => {
    await assert.rejects(new GitHubClient(config).importFiles(files, (...value) => progress.push(value)), error => {
      assert.ok(error instanceof GitHubError)
      assert.equal(error.status, 403)
      return assertProgress(error, { uploaded: 1, skipped: 0, total: 2, path: files[1].path })
    })
    assert.deepEqual(progress.at(-1), [1, 2, 0])
    assert.equal(api.files.size, 1)
    assert.deepEqual(api.files.get(files[0].path)!.bytes, files[0].bytes)
  })
})

test('large existing backups are compared through their authenticated Git blob', async () => {
  const api = remote(), file = backupFile()
  file.bytes = encoder.encode(new TextDecoder().decode(file.bytes) + ' '.repeat(1_100_000))
  const existing = api.put(file.path, file.bytes)
  await usingFetch(call => {
    if (call.method === 'GET' && decodeURIComponent(call.url.pathname).endsWith(`/contents/${file.path}`)) return jsonResponse({ type: 'file', sha: existing.sha, path: file.path, encoding: 'none', content: '' })
    return api.respond(call)
  }, async calls => {
    assert.deepEqual(await new GitHubClient(config).importFiles([file]), { uploaded: 0, skipped: 1 })
    assert.equal(calls.filter(call => call.url.pathname.endsWith(`/git/blobs/${existing.sha}`)).length, 1)
    assert.equal(calls.some(call => call.method === 'PUT'), false)
  })
})

test('disconnect prevents imports from retaining usable authentication or making any request', async () => {
  await usingFetch(() => { throw new Error('Disconnected clients cannot make requests') }, async calls => {
    const client = new GitHubClient(config)
    client.disconnect()
    await assert.rejects(client.importFiles([recordFile()]), (error: unknown) => error instanceof GitHubError && error.kind === 'disconnected')
    assert.equal(calls.length, 0)
  })
})

test('bulk import serializes with ordinary record creation instead of racing repository writes', async () => {
  const api = remote(), imported = recordFile()
  let began!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let blocked = true
  await usingFetch(async call => {
    if (call.method === 'PUT' && blocked) { blocked = false; began(); await held }
    return api.respond(call)
  }, async calls => {
    const client = new GitHubClient(config)
    const importPromise = client.importFiles([imported])
    await started
    const createPromise = client.create(record({ id: 'fictional-new-record', is_legacy: false }))
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(calls.filter(call => call.method === 'PUT').length, 1)
    assert.equal(calls.filter(call => call.method === 'GET' && call.url.pathname.includes('/contents/')).length, 1)
    release()
    const [result, created] = await Promise.all([importPromise, createPromise])
    assert.deepEqual(result, { uploaded: 1, skipped: 0 })
    assert.equal(created.record.id, 'fictional-new-record')
    assert.equal(api.files.size, 2)
    const paths = calls.filter(call => call.method === 'PUT').map(call => decodeURIComponent(call.url.pathname))
    assert.ok(paths[0].endsWith(imported.path))
    assert.ok(paths[1].endsWith(created.path))
  })
})
