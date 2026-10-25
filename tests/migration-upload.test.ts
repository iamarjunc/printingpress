import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadMigration } from '../scripts/import-github.ts';

const path = 'records/2020/01/2020-01-03T05-35-37-400Z_legacy-a1.json';
const bytes = Buffer.from('{"id":"legacy-test"}\n');
const options = { owner: 'example', repo: 'private-test', branch: 'main', token: 'synthetic-unit-test-value', files: [{ path, bytes }] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('legacy upload refuses a public data repository before making any content request', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; return json({ private: false }); };
  await assert.rejects(uploadMigration(options, transport), /must be private/);
  assert.equal(calls, 1);
});

test('legacy upload verifies identical remote bytes and creates no duplicate commit', async () => {
  let writes = 0;
  const transport: typeof fetch = async (url, init) => {
    if (init?.method === 'PUT') writes++;
    if (String(url).includes('/branches/')) return json({ commit: { sha: 'branch-head' } });
    if (String(url).includes('/contents/')) return json({ type: 'file', content: bytes.toString('base64') });
    return json({ private: true });
  };
  assert.deepEqual(await uploadMigration(options, transport), { uploaded: 0, skipped: 1 });
  assert.equal(writes, 0);
});

test('legacy upload refuses to overwrite a different historical remote file', async () => {
  let writes = 0;
  const transport: typeof fetch = async (url, init) => {
    if (init?.method === 'PUT') writes++;
    if (String(url).includes('/branches/')) return json({ commit: { sha: 'branch-head' } });
    if (String(url).includes('/contents/')) return json({ type: 'file', content: Buffer.from('edited historical record').toString('base64') });
    return json({ private: true });
  };
  await assert.rejects(uploadMigration(options, transport), /Refusing to overwrite/);
  assert.equal(writes, 0);
});

test('legacy upload counts success only after confirmed content and commit SHAs', async () => {
  let writes = 0;
  let notifications = 0;
  const transport: typeof fetch = async (url, init) => {
    if (init?.method === 'PUT') {
      writes++;
      const request = JSON.parse(String(init.body));
      assert.equal(request.branch, 'main');
      assert.equal(request.content, bytes.toString('base64'));
      assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${options.token}`);
      assert.ok(!String(url).includes(options.token));
      return json({ content: { sha: 'blob' }, commit: { sha: 'commit' } }, 201);
    }
    if (String(url).includes('/branches/')) return json({ commit: { sha: 'branch-head' } });
    if (String(url).includes('/contents/')) return json({}, 404);
    return json({ private: true });
  };
  assert.deepEqual(await uploadMigration({ ...options, onCommit: () => notifications++ }, transport), { uploaded: 1, skipped: 0 });
  assert.equal(writes, 1);
  assert.equal(notifications, 1);
});

test('legacy upload never announces success from an incomplete or uncertain write response', async () => {
  for (const uncertain of [false, true]) {
    let notifications = 0;
    const transport: typeof fetch = async (url, init) => {
      if (init?.method === 'PUT') {
        if (uncertain) throw new TypeError('Connection lost');
        return json({ content: { sha: 'blob-only' } }, 201);
      }
      if (String(url).includes('/branches/')) return json({ commit: { sha: 'branch-head' } });
      if (String(url).includes('/contents/')) return json({}, 404);
      return json({ private: true });
    };
    await assert.rejects(uploadMigration({ ...options, onCommit: () => notifications++ }, transport), /confirm|reconcile/);
    assert.equal(notifications, 0);
  }
});
