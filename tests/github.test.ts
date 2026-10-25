import assert from 'node:assert/strict'
import test from 'node:test'
import { GitHubClient, GitHubError } from '../src/lib/github.ts'
import { recordPath } from '../src/lib/records.ts'
import type { PrintingRecord, StoredRecord } from '../src/types.ts'

const SHA = {
  old: '0000000000000000000000000000000000000001',
  new: '0000000000000000000000000000000000000002',
  commit: '0000000000000000000000000000000000000003',
  other: '0000000000000000000000000000000000000004',
  file: '0000000000000000000000000000000000000005',
  deleted: '0000000000000000000000000000000000000006',
  newer: '0000000000000000000000000000000000000007',
  head: '0000000000000000000000000000000000000008',
  root: '0000000000000000000000000000000000000009',
  valid: '000000000000000000000000000000000000000a',
  invalid: '000000000000000000000000000000000000000b',
  irrelevant: '000000000000000000000000000000000000000c',
  photo: '000000000000000000000000000000000000000d',
  cleanup: '000000000000000000000000000000000000000e',
  records: '000000000000000000000000000000000000000f',
  year: '0000000000000000000000000000000000000010',
  month: '0000000000000000000000000000000000000011',
  incomplete: '0000000000000000000000000000000000000012',
  unrelated: '0000000000000000000000000000000000000013',
}
const config = { owner: 'family', repo: 'private-records', branch: 'main', token: 'test-token-not-a-real-secret' }
const record = (changes: Partial<PrintingRecord> = {}): PrintingRecord => ({
  id: '7d5844ad-353f-4779-b814-501a297fd422', customer_name: 'ശ്രീ പ്രിന്റേഴ്സ്', bill_type: 'Invoice',
  start_no: 1, end_no: 500, pages: 50, books: 10, added_by: 'Appu',
  created_at: '2026-10-25T06:00:00.000Z', updated_at: null,
  date_key: '2026-10-25', photo_path: null, is_legacy: false, ...changes,
})
const stored = (): StoredRecord => ({ record: record(), path: recordPath(record()), sha: SHA.old })
const encode = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64')
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const commit = (sha = SHA.new, path = recordPath(record())) => ({ commit: { sha: SHA.commit }, content: { sha, path } })
type Call = { url: URL; method: string; body: Record<string, unknown>; headers: Headers }

async function usingFetch<T>(handler: (call: Call) => Response | Promise<Response>, action: (calls: Call[]) => Promise<T>): Promise<T> {
  const previousFetch = globalThis.fetch
  const calls: Call[] = []
  let mockFailure: unknown
  globalThis.fetch = async (input, init) => {
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const call = { url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : {}, headers: new Headers(init?.headers) }
      calls.push(call)
      assert.equal(url.origin, 'https://api.github.com')
      assert.equal(url.href.includes(config.token), false, 'tokens must never appear in URLs')
      assert.equal(call.headers.get('authorization'), `Bearer ${config.token}`)
      return await handler(call)
    } catch (error) {
      // A TypeError deliberately models a lost network connection in one test.
      // All assertion/unexpected-route failures must escape service error wrapping.
      if (!(error instanceof TypeError)) mockFailure = error
      throw error
    }
  }

  try { return await action(calls) } finally {
    globalThis.fetch = previousFetch
    if (mockFailure) throw mockFailure
  }
}

test('create commits one UTF-8 JSON file and returns only after GitHub confirms a commit', async () => {
  await usingFetch(call => {
    if (call.method === 'GET') return response({ message: 'Not Found' }, 404)
    assert.equal(call.method, 'PUT')
    assert.equal(call.url.pathname, `/repos/family/private-records/contents/${recordPath(record())}`)
    assert.equal(call.body.branch, 'main')
    assert.equal(call.body.sha, undefined)
    const decoded = JSON.parse(Buffer.from(call.body.content as string, 'base64').toString('utf8'))
    assert.deepEqual(decoded, record())
    assert.equal(decoded.customer_name, 'ശ്രീ പ്രിന്റേഴ്സ്')
    return response(commit(), 201)
  }, async calls => {
    const result = await new GitHubClient(config).create(record())
    assert.equal(result.sha, SHA.new)
    assert.equal(result.path, recordPath(record()))
    assert.deepEqual(result.record, record())
    assert.equal(calls.length, 2)
  })
})

test('a successful HTTP status without commit evidence is never reported as saved', async () => {
  await usingFetch(call => call.method === 'GET' ? response({ message: 'Not Found' }, 404) : response({ content: { sha: SHA.file } }, 200), async () => {
    await assert.rejects(new GitHubClient(config).create(record()), /commit|confirm/i)
  })
})

test('update checks current SHA and blocks a concurrent edit without overwriting it', async () => {
  await usingFetch(call => {
    assert.equal(call.method, 'GET')
    assert.equal(call.url.searchParams.get('ref'), 'main')
    return response({ sha: SHA.other, content: encode(record()), encoding: 'base64' })
  }, async calls => {
    await assert.rejects(new GitHubClient(config).update(stored(), record({ customer_name: 'Edited customer' })), (error: unknown) => {
      assert.ok(error instanceof GitHubError)
      assert.match(error.message, /changed|conflict|refresh/i)
      return true
    })
    assert.equal(calls.length, 1)
  })
})

test('update reuses the original file and SHA instead of creating a duplicate order', async () => {
  await usingFetch(call => {
    assert.equal(call.url.pathname, `/repos/family/private-records/contents/${stored().path}`)
    if (call.method === 'GET') return response({ sha: SHA.old, content: encode(record()), encoding: 'base64' })
    assert.equal(call.method, 'PUT')
    assert.equal(call.body.sha, SHA.old)
    const edited = JSON.parse(Buffer.from(call.body.content as string, 'base64').toString('utf8'))
    assert.equal(edited.created_at, record().created_at)
    assert.equal(edited.customer_name, 'Edited customer')
    assert.ok(edited.updated_at)
    return response(commit())
  }, async calls => {
    const result = await new GitHubClient(config).update(stored(), record({ customer_name: 'Edited customer' }))
    assert.equal(result.path, stored().path)
    assert.equal(result.sha, SHA.new)
    assert.equal(calls.length, 2)
  })
})

test('delete uses the confirmed current SHA, and rejects a stale record before deleting', async () => {
  await usingFetch(call => {
    if (call.method === 'GET') return response({ sha: SHA.old })
    assert.equal(call.method, 'DELETE')
    assert.equal(call.body.sha, SHA.old)
    assert.equal(call.body.branch, 'main')
    return response({ commit: { sha: SHA.deleted } })
  }, async calls => {
    const result = await new GitHubClient(config).delete(stored())
    assert.deepEqual(result.warnings, [])
    assert.equal(calls.length, 2)
  })
  await usingFetch(() => response({ sha: SHA.newer }), async calls => {
    await assert.rejects(new GitHubClient(config).delete(stored()), /changed|refresh|conflict/i)
    assert.equal(calls.length, 1)
  })
})

test('a server-side SHA conflict after preflight is surfaced without an automatic overwrite retry', async () => {
  await usingFetch(call => call.method === 'GET'
    ? response({ sha: SHA.old })
    : response({ message: 'sha does not match' }, 409), async calls => {
    await assert.rejects(new GitHubClient(config).update(stored(), record()), (error: unknown) => {
      assert.ok(error instanceof GitHubError)
      assert.equal(error.status, 409)
      return true
    })
    assert.equal(calls.filter(call => call.method === 'PUT').length, 1)
  })
})

test('incremental reads reuse unchanged blobs and surface malformed record files', async () => {
  await usingFetch(call => {
    if (call.url.pathname.includes('/commits/')) return response({ sha: SHA.head, commit: { tree: { sha: SHA.root } } })
    if (call.url.pathname.includes('/git/trees/')) return response({ truncated: false, tree: [
      { path: recordPath(record()), type: 'blob', sha: SHA.valid },
      { path: 'records/2026/10/broken.json', type: 'blob', sha: SHA.invalid },
      { path: 'README.md', type: 'blob', sha: SHA.irrelevant },
    ] })
    if (call.url.pathname.endsWith('/' + SHA.valid)) return response({ encoding: 'base64', content: encode(record()) })
    if (call.url.pathname.endsWith('/' + SHA.invalid)) return response({ encoding: 'base64', content: encode('{broken') })
    throw new Error(`Unexpected request: ${call.url.pathname}`)
  }, async calls => {
    const client = new GitHubClient(config)
    const first = await client.loadRecords()
    assert.equal(first.records.length, 1)
    assert.equal(first.records[0].record.customer_name, 'ശ്രീ പ്രിന്റേഴ്സ്')
    assert.equal(first.issues.length, 1)
    assert.match(first.issues[0], /broken\.json/)
    const downloads = calls.filter(call => call.url.pathname.endsWith('/git/blobs/' + SHA.valid)).length
    const second = await client.loadRecords()
    assert.equal(second.records.length, 1)
    assert.equal(second.issues.length, 1)
    assert.equal(calls.filter(call => call.url.pathname.endsWith('/git/blobs/' + SHA.valid)).length, downloads)
    assert.equal(calls.some(call => call.url.pathname.endsWith('/' + SHA.irrelevant)), false)
  })
})

test('rate-limit errors carry a reset time and authentication failures are distinct', async () => {
  await usingFetch(() => response({ message: 'API rate limit exceeded' }, 403, {
    'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '2000000000',
  }), async () => {
    await assert.rejects(new GitHubClient(config).loadRecords(), (error: unknown) => {
      assert.ok(error instanceof GitHubError)
      assert.equal(error.status, 403)
      assert.ok(error.retryAt instanceof Date)
      assert.equal(error.retryAt.getTime(), 2_000_000_000_000)
      return true
    })
  })
  await usingFetch(() => response({ message: 'Bad credentials' }, 401), async () => {
    await assert.rejects(new GitHubClient(config).loadRecords(), (error: unknown) => error instanceof GitHubError && error.status === 401)
  })
})

test('photo is a separate file and a confirmed failed record write cleans up the new upload', async () => {
  await usingFetch(call => {
    if (call.url.pathname.includes('/commits/')) return response({ sha: SHA.head, commit: { tree: { sha: SHA.root } } })
    if (call.url.pathname.includes('/git/trees/')) return response({ tree: [], truncated: false })
    if (call.method === 'GET' && call.url.pathname.includes('/contents/records/')) return response({ message: 'Not Found' }, 404)
    if (call.method === 'GET' && call.url.pathname.includes('/contents/images/')) return response({ sha: SHA.photo })
    if (call.method === 'PUT' && call.url.pathname.includes('/contents/images/')) return response(commit(SHA.photo, call.url.pathname.split('/contents/')[1]), 201)
    if (call.method === 'PUT') {
      const payload = JSON.parse(Buffer.from(call.body.content as string, 'base64').toString('utf8'))
      assert.match(payload.photo_path, /^images\/\d{4}\/\d{2}\/.+\.jpg$/)
      assert.equal('photo_base64' in payload, false)
      return response({ message: 'Validation failed' }, 422)
    }
    assert.equal(call.method, 'DELETE')
    assert.ok(call.url.pathname.includes('/contents/images/'))
    assert.equal(call.body.sha, SHA.photo)
    return response({ commit: { sha: SHA.cleanup } })
  }, async calls => {
    await assert.rejects(new GitHubClient(config).create(record(), new Blob(['test-image'], { type: 'image/jpeg' })))
    assert.equal(calls.filter(call => call.method === 'DELETE').length, 1)
  })
})

test('uncertain network failure does not remove a photo a committed record may reference', async () => {
  await usingFetch(call => {
    if (call.method === 'GET') return response({ message: 'Not Found' }, 404)
    if (call.url.pathname.includes('/contents/images/')) return response(commit(SHA.photo, call.url.pathname.split('/contents/')[1]), 201)
    throw new TypeError('Network connection lost')
  }, async calls => {
    await assert.rejects(new GitHubClient(config).create(record(), new Blob(['test-image'], { type: 'image/jpeg' })), /refresh|uncertain|confirm|unknown/i)
    assert.equal(calls.length, 3)
    assert.equal(calls.some(call => call.method === 'DELETE'), false)
  })
})

test('path traversal and remote photo URLs are rejected before any authenticated request', async () => {
  await usingFetch(() => { throw new Error('No request should occur') }, async calls => {
    await assert.rejects(new GitHubClient(config).loadPhoto('https://attacker.test/leak.jpg'))
    await assert.rejects(new GitHubClient(config).delete({ ...stored(), path: '../README.md' }))
    assert.equal(calls.length, 0)
  })
})

test('disconnect destroys the active session and prevents further requests', async () => {
  await usingFetch(() => { throw new Error('No request should occur') }, async calls => {
    const client = new GitHubClient(config)
    client.disconnect()
    await assert.rejects(client.loadRecords(), /disconnect|session|connect/i)
    assert.equal(calls.length, 0)
  })
})

test('truncated recursive trees are fully traversed instead of silently omitting older records', async () => {
  const filename = recordPath(record()).split('/').at(-1)!
  await usingFetch(call => {
    if (call.url.pathname.includes('/commits/')) return response({ sha: SHA.head, commit: { tree: { sha: SHA.root } } })
    if (call.url.pathname.endsWith('/git/trees/' + SHA.root) && call.url.searchParams.get('recursive') === '1') return response({ truncated: true, tree: [
      { path: 'records/2026/10/incomplete.json', type: 'blob', sha: SHA.incomplete },
    ] })
    if (call.url.pathname.endsWith('/git/trees/' + SHA.root)) return response({ truncated: false, tree: [
      { path: 'records', type: 'tree', sha: SHA.records },
      { path: 'unrelated', type: 'tree', sha: SHA.unrelated },
    ] })
    if (call.url.pathname.endsWith('/git/trees/' + SHA.records)) return response({ truncated: false, tree: [{ path: '2026', type: 'tree', sha: SHA.year }] })
    if (call.url.pathname.endsWith('/git/trees/' + SHA.year)) return response({ truncated: false, tree: [{ path: '10', type: 'tree', sha: SHA.month }] })
    if (call.url.pathname.endsWith('/git/trees/' + SHA.month)) return response({ truncated: false, tree: [{ path: filename, type: 'blob', sha: SHA.valid }] })
    if (call.url.pathname.endsWith('/git/blobs/' + SHA.valid)) return response({ encoding: 'base64', content: encode(record()) })
    throw new Error(`Unexpected request: ${call.url.pathname}`)
  }, async calls => {
    const result = await new GitHubClient(config).loadRecords()
    assert.equal(result.records.length, 1)
    assert.deepEqual(result.issues, [])
    assert.equal(result.records[0].path, recordPath(record()))
    assert.equal(calls.some(call => /never-use|never-traverse/.test(call.url.pathname)), false)
  })
})

test('private photos are fetched through the authenticated API and decoded without public URLs', async () => {
  await usingFetch(call => {
    assert.equal(call.method, 'GET')
    if (call.url.pathname.endsWith('/contents/images/2026/10/photo.jpg')) return response({ sha: SHA.photo })
    assert.equal(call.url.pathname, '/repos/family/private-records/git/blobs/' + SHA.photo)
    return response({ encoding: 'base64', content: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  }, async () => {
    const blob = await new GitHubClient(config).loadPhoto('images/2026/10/photo.jpg')
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9])
    assert.equal(blob.type, 'image/jpeg')
  })
})

test('retrying an uncertain create confirms an identical committed file without creating a duplicate', async () => {
  await usingFetch(call => {
    assert.equal(call.method, 'GET')
    assert.equal(call.url.pathname, `/repos/family/private-records/contents/${recordPath(record())}`)
    return response({ sha: SHA.old, content: encode(record()), encoding: 'base64' })
  }, async calls => {
    const client = new GitHubClient(config)
    const result = await client.create(record())
    assert.equal(result.sha, SHA.old)
    assert.deepEqual(result.record, record())
    assert.equal(calls.length, 1)
    assert.ok(client.warnings.some(warning => /already saved|duplicate/i.test(warning)))
  })
})

test('a different record at the deterministic create path is never overwritten', async () => {
  await usingFetch(call => {
    assert.equal(call.method, 'GET')
    return response({ sha: SHA.old, content: encode(record({ customer_name: 'Another customer' })), encoding: 'base64' })
  }, async calls => {
    await assert.rejects(new GitHubClient(config).create(record()), /different record|review/i)
    assert.equal(calls.length, 1)
  })
})

test('cleanup retains an image referenced by another committed record', async () => {
  let uploadedPhotoPath = ''
  await usingFetch(call => {
    if (call.url.pathname.includes('/commits/')) return response({ sha: SHA.head, commit: { tree: { sha: SHA.root } } })
    if (call.url.pathname.includes('/git/trees/')) return response({ truncated: false, tree: [{ path: 'records/2026/10/other.json', type: 'blob', sha: SHA.valid }] })
    if (call.url.pathname.endsWith('/git/blobs/' + SHA.valid)) return response({ encoding: 'base64', content: encode(record({ id: 'other-record', photo_path: uploadedPhotoPath })) })
    if (call.method === 'GET') return response({ message: 'Not Found' }, 404)
    if (call.url.pathname.includes('/contents/images/')) {
      uploadedPhotoPath = call.url.pathname.split('/contents/')[1]
      return response(commit(SHA.photo, uploadedPhotoPath), 201)
    }
    assert.equal(call.method, 'PUT')
    return response({ message: 'Validation failed' }, 422)
  }, async calls => {
    const client = new GitHubClient(config)
    await assert.rejects(client.create(record(), new Blob(['test-image'], { type: 'image/jpeg' })))
    assert.equal(calls.some(call => call.method === 'DELETE'), false)
    assert.ok(client.warnings.some(warning => /referenced|kept/.test(warning)))
  })
})
