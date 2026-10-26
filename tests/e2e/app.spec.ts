import { expect, test, type Page, type Route } from '@playwright/test'
import type { PrintingRecord } from '../../src/types'

const TOKEN = 'github_pat_fictional_test_token'
const sample = (id: string, changes: Partial<PrintingRecord> = {}): PrintingRecord => ({
  id, customer_name: 'Demo Stationery', bill_type: 'Sample invoice', start_no: 201, end_no: 800,
  pages: 60, books: 10, added_by: 'Sreelekha', created_at: '2022-02-14T08:15:30.123456+00:00',
  updated_at: null, date_key: '2022-02-14', photo_path: null, is_legacy: true, ...changes,
})
interface FakeFile { sha: string; content: Buffer }
async function mockGitHub(page: Page, seed: PrintingRecord[] = [sample('old-1')]) {
  let revision = 1
  const sha = () => (revision++).toString(16).padStart(40, '0')
  const db = new Map<string, FakeFile>()
  seed.forEach((record, i) => db.set(`records/2022/02/old-${i}.json`, { sha: sha(), content: Buffer.from(JSON.stringify(record)) }))
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = []
  const calls: string[] = []
  let denied = false
  let dropNextSave = false
  let heldTree: { started: () => void; resumed: Promise<void>; complete: () => void } | null = null
  let heldAccess: { started: () => void; resumed: Promise<void>; complete: () => void } | null = null
  let heldWrite: { started: () => void; resumed: Promise<void> } | null = null
  await page.route('https://api.github.com/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method()
    calls.push(request.url())
    expect(url.search).not.toContain(TOKEN)
    expect(request.headers().authorization).toBe(`Bearer ${TOKEN}`)
    const path = decodeURIComponent(url.pathname.replace('/repos/family/press-data', ''))
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (denied) return respond({ message: 'Bad credentials' }, 401)
    if (path === '') { const held = heldAccess; heldAccess = null; if (held) { held.started(); await held.resumed } try { return await respond({ private: true, permissions: { push: true } }) } finally { held?.complete() } }
    if (path === '/commits/main') return respond({ sha: revision.toString(16).padStart(40, 'c'), commit: { tree: { sha: revision.toString(16).padStart(40, 'd') } } })
    if (path.startsWith('/git/trees/')) {
      const snapshot = { truncated: false, tree: [...db].filter(([key]) => key.startsWith('records/')).map(([key, file]) => ({ type: 'blob', path: key, sha: file.sha })) }
      const held = heldTree; heldTree = null
      if (held) { held.started(); await held.resumed }
      try { return await respond(snapshot) } finally { held?.complete() }
    }
    if (path.startsWith('/git/blobs/')) {
      const file = [...db.values()].find(file => file.sha === path.slice('/git/blobs/'.length))
      return file ? respond({ encoding: 'base64', content: file.content.toString('base64') }) : respond({ message: 'Not Found' }, 404)
    }
    if (path.startsWith('/contents/')) {
      const key = path.slice('/contents/'.length), file = db.get(key)
      if (method === 'GET') return file ? respond({ type: 'file', sha: file.sha, path: key, encoding: 'base64', content: file.content.toString('base64') }) : respond({ message: 'Not Found' }, 404)
      const body = request.postDataJSON() as Record<string, unknown>
      writes.push({ method, path: key, body })
      if ((file && body.sha !== file.sha) || (!file && body.sha)) return respond({ message: 'SHA does not match' }, 409)
      if (method === 'DELETE') { db.delete(key); return respond({ commit: { sha: sha() } }) }
      if (method === 'PUT') {
        const held = heldWrite; heldWrite = null
        if (held) { held.started(); await held.resumed }
        const next = { sha: sha(), content: Buffer.from(String(body.content), 'base64') }
        db.set(key, next)
        if (dropNextSave) { dropNextSave = false; return route.abort('failed') }
        return respond({ content: { sha: next.sha, path: key }, commit: { sha: sha() } }, 201)
      }
    }
    throw new Error(`Unhandled GitHub mock request: ${method} ${url.pathname}`)
  })
  return { db, writes, calls, pauseNextWrite: () => { let started!: () => void, resume!: () => void; const began = new Promise<void>(resolve => { started = resolve }); const resumed = new Promise<void>(resolve => { resume = resolve }); heldWrite = { started, resumed }; return { began, resume } }, pauseNextAccess: () => { let started!: () => void, resume!: () => void, complete!: () => void; const began = new Promise<void>(resolve => { started = resolve }); const resumed = new Promise<void>(resolve => { resume = resolve }); const done = new Promise<void>(resolve => { complete = resolve }); heldAccess = { started, resumed, complete }; return { began, resume, done } }, pauseNextTree: () => { let started!: () => void, resume!: () => void, complete!: () => void; const began = new Promise<void>(resolve => { started = resolve }); const resumed = new Promise<void>(resolve => { resume = resolve }); const done = new Promise<void>(resolve => { complete = resolve }); heldTree = { started, resumed, complete }; return { began, resume, done } }, loseNextConfirmation: () => { dropNextSave = true }, rejectAuthentication: () => { denied = true }, changeSha: (path: string) => { const file = db.get(path)!; db.set(path, { sha: sha(), content: Buffer.from(JSON.stringify({ ...JSON.parse(file.content.toString()), books: 19, updated_at: '2026-10-25T12:00:00.000Z' })) }) } }
}
async function connect(page: Page, remember = false) {
  await page.getByRole('button', { name: 'Set up this phone', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Repository owner').fill('family')
  await dialog.getByLabel('Data repository', { exact: true }).fill('press-data')
  await dialog.getByLabel('Branch').fill('main')
  await dialog.getByLabel('Fine-grained personal access token').fill(TOKEN)
  if (remember) await dialog.getByLabel('Keep this phone connected', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Connect to GitHub', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByText('Ready', { exact: true })).toBeVisible()
}
async function navigate(page: Page, name: string) { await page.locator('.desktop-nav').getByRole('button', { name, exact: true }).click() }
async function fillOrder(page: Page, customer = 'New Print Customer') {
  const form = page.locator('.record-form:visible')
  await form.getByLabel('Customer name', { exact: true }).fill(customer)
  await form.getByLabel('Bill type', { exact: true }).fill('Receipt')
  await form.getByLabel('Start number', { exact: true }).fill('101')
  await form.getByLabel('End number', { exact: true }).fill('600')
  await form.getByLabel('Pages per book', { exact: true }).fill('50')
  await form.getByLabel('Number of books', { exact: true }).fill('10')
  await form.getByLabel('Added by', { exact: true }).selectOption('Appu')
  return form
}

test('mobile navigation, disconnected form and unsaved draft remain usable without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Your press, at a glance.' })).toBeVisible()
  await expect(page.locator('.mobile-nav').getByRole('button')).toHaveCount(4)
  await expect(page.locator('.mobile-nav').getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Fine-grained personal access token')).toHaveCount(0)
  await page.locator('.mobile-nav').getByRole('button', { name: 'Add record', exact: true }).click()
  const form = page.locator('.record-form:visible')
  await form.getByLabel('Customer name', { exact: true }).fill('മലയാളം പ്രിന്റ്')
  await expect(form.getByLabel('Added by', { exact: true }).locator('option')).toHaveText(['Select family member', 'Chandrakumar', 'Sreelekha', 'Appu', 'Akku'])
  await expect(form.getByRole('button', { name: 'Save record', exact: true })).toBeDisabled()
  await page.locator('.mobile-nav').getByRole('button', { name: 'Home', exact: true }).click()
  await page.locator('.mobile-nav').getByRole('button', { name: 'Add record', exact: true }).click()
  await expect(form.getByLabel('Customer name', { exact: true })).toHaveValue('മലയാളം പ്രിന്റ്')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  for (const label of ['Records', 'Customers', 'Home']) {
    await page.locator('.mobile-nav').getByRole('button', { name: label, exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await expect(page.getByLabel('Fine-grained personal access token')).toHaveCount(0)
  await page.getByRole('button', { name: 'Set up this phone', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Fine-grained personal access token')).toBeVisible()
  await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(dialog).not.toBeVisible()
})

test('connects to private GitHub storage, groups customers without losing original records, and clears auth on disconnect', async ({ page }) => {
  const api = await mockGitHub(page, [sample('old-1'), sample('old-2', { customer_name: 'DEMO STATIONERY', start_no: 801, end_no: 1400 }), sample('old-3', { customer_name: 'Demo Workshop', books: 5 })])
  await page.goto('/')
  await connect(page)
  expect(await inspectSavedDevice(page)).toBeNull()
  await expect(page.locator('.stat-card').nth(0).locator('.stat-value')).toHaveText('3')
  await expect(page.locator('.stat-card').nth(1).locator('.stat-value')).toHaveText('2')
  await navigate(page, 'Customers')
  await expect(page.locator('.customer-card')).toHaveCount(2)
  await expect(page.locator('.customer-card').filter({ hasText: 'Demo Stationery' }).getByText('2 orders', { exact: true })).toBeVisible()
  await navigate(page, 'Add record')
  const form = page.locator('.record-form:visible')
  await form.getByLabel('Customer name', { exact: true }).fill('demo stationery')
  await expect(form.locator('.history-entry')).toHaveCount(2)
  await expect(form.locator('.history-range').first()).toHaveText(/201.*800/)
  await page.getByRole('button', { name: 'Open device setup', exact: true }).click()
  page.on('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Disconnect this session', exact: true }).click()
  await expect(page.getByText('Not connected', { exact: true })).toBeVisible()
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))
  expect(JSON.stringify(storage)).not.toContain(TOKEN)
  expect(JSON.stringify(storage)).not.toContain('Demo Stationery')
  expect(api.writes).toHaveLength(0)
})

test('confirmed create, update and explicitly confirmed delete use the same individual GitHub file', async ({ page }) => {
  const api = await mockGitHub(page, [])
  await page.goto('/')
  await connect(page)
  await navigate(page, 'Add record')
  const form = await fillOrder(page)
  await form.getByRole('button', { name: 'Save record', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Record saved.' })).toBeVisible()
  expect(api.writes).toHaveLength(1)
  const created = api.writes[0]
  expect(created.path).toMatch(/^records\/\d{4}\/\d{2}\/.*\.json$/)
  expect(created.body.sha).toBeUndefined()
  const firstRecord = JSON.parse(Buffer.from(String(created.body.content), 'base64').toString())
  expect(firstRecord.added_by).toBe('Appu')
  expect(firstRecord.photo_path).toBeNull()
  expect(firstRecord.is_legacy).toBe(false)
  await page.getByRole('button', { name: `View New Print Customer record ${firstRecord.id}`, exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Edit', exact: true }).click()
  const edit = page.getByRole('dialog')
  await edit.getByLabel('Number of books', { exact: true }).fill('12')
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(edit).not.toBeVisible()
  expect(api.writes).toHaveLength(2)
  expect(api.writes[1].path).toBe(created.path)
  expect(api.writes[1].body.sha).toMatch(/^[a-f0-9]{40}$/)
  const updated = JSON.parse(Buffer.from(String(api.writes[1].body.content), 'base64').toString())
  expect(updated.created_at).toBe(firstRecord.created_at)
  expect(updated.books).toBe(12)
  expect(updated.updated_at).toBeTruthy()
  await page.getByRole('button', { name: `View New Print Customer record ${firstRecord.id}`, exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  expect(api.writes).toHaveLength(2)
  const confirmation = page.getByRole('dialog').filter({ hasText: 'Delete this record?' })
  await confirmation.getByRole('button', { name: 'Delete record', exact: true }).click()
  await expect(confirmation).not.toBeVisible()
  expect(api.writes).toHaveLength(3)
  expect(api.writes[2].method).toBe('DELETE')
  expect(api.writes[2].path).toBe(created.path)
  expect(api.db.size).toBe(0)
})

test('stale SHA conflict preserves entered edits and never reports a successful save', async ({ page }) => {
  const api = await mockGitHub(page)
  await page.goto('/')
  await connect(page)
  await page.getByRole('button', { name: 'View Demo Stationery record old-1', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Edit', exact: true }).click()
  const edit = page.getByRole('dialog')
  await edit.getByLabel('Number of books', { exact: true }).fill('23')
  api.changeSha('records/2022/02/old-0.json')
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(edit.getByRole('alert')).toContainText('changed by someone else')
  await expect(edit.getByLabel('Number of books', { exact: true })).toHaveValue('23')
  await expect(edit.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  expect(api.writes).toHaveLength(0)
  await expect(page.getByText('Changes saved.', { exact: true })).toHaveCount(0)
  await edit.getByRole('button', { name: 'Review latest version', exact: true }).click()
  await expect(edit.getByText('Latest version loaded — your entered changes are kept', { exact: true })).toBeVisible()
  await expect(edit.getByText('19 books', { exact: true })).toBeVisible()
  await expect(edit.getByLabel('Number of books', { exact: true })).toHaveValue('23')
  await expect(edit.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  await edit.getByRole('button', { name: 'I reviewed the latest version', exact: true }).click()
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(edit).not.toBeVisible()
  expect(api.writes).toHaveLength(1)
  expect(JSON.parse(Buffer.from(String(api.writes[0].body.content), 'base64').toString()).books).toBe(23)
})

test('authentication failure is visible and token is never persisted', async ({ page }) => {
  const api = await mockGitHub(page)
  api.rejectAuthentication()
  await page.goto('/')
  await page.getByRole('button', { name: 'Set up this phone', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Repository owner').fill('family')
  await dialog.getByLabel('Data repository', { exact: true }).fill('press-data')
  await dialog.getByLabel('Fine-grained personal access token').fill(TOKEN)
  await dialog.getByRole('button', { name: 'Connect to GitHub', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('rejected this token')
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(TOKEN)
  expect(api.writes).toHaveLength(0)
})

test('a lost create confirmation keeps the entry and an exact retry does not create a duplicate', async ({ page }) => {
  const api = await mockGitHub(page, [])
  await page.goto('/')
  await connect(page)
  await navigate(page, 'Add record')
  const form = await fillOrder(page, 'Retry Customer')
  api.loseNextConfirmation()
  await form.getByRole('button', { name: 'Save record', exact: true }).click()
  await expect(form.getByRole('alert')).toContainText('did not confirm')
  await expect(form.getByLabel('Customer name', { exact: true })).toHaveValue('Retry Customer')
  expect(api.db.size).toBe(1)
  expect(api.writes).toHaveLength(1)
  await form.getByRole('button', { name: 'Save record', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'already saved' })).toBeVisible()
  expect(api.db.size).toBe(1)
  expect(api.writes).toHaveLength(1)
})

test('reference photos are compressed into separate files and removal updates the record before cleanup', async ({ page }) => {
  const api = await mockGitHub(page, [])
  await page.goto('/')
  await connect(page)
  await navigate(page, 'Add record')
  const form = await fillOrder(page, 'Photo Customer')
  await form.getByLabel('Choose reference photo', { exact: true }).setInputFiles({
    name: 'sample.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvGQAAAAASUVORK5CYII=', 'base64'),
  })
  await expect(form.getByText('Photo ready to attach', { exact: true })).toBeVisible()
  await form.getByRole('button', { name: 'Save record', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Record saved.' })).toBeVisible()
  expect(api.writes).toHaveLength(2)
  expect(api.writes[0].path).toMatch(/^images\/\d{4}\/\d{2}\/.*\.(jpg|webp)$/)
  const record = JSON.parse(Buffer.from(String(api.writes[1].body.content), 'base64').toString())
  expect(record.photo_path).toBe(api.writes[0].path)
  expect(JSON.stringify(record)).not.toContain('base64')
  await page.getByRole('button', { name: `View Photo Customer record ${record.id}`, exact: true }).click()
  await expect(page.getByRole('dialog').getByAltText('Printing order reference')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Edit', exact: true }).click()
  const edit = page.getByRole('dialog')
  await edit.getByRole('button', { name: 'Remove photo', exact: true }).click()
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(edit).not.toBeVisible()
  expect(api.writes).toHaveLength(4)
  expect(api.writes[2].method).toBe('PUT')
  expect(api.writes[3].method).toBe('DELETE')
  expect(api.writes[3].path).toBe(record.photo_path)
  expect([...api.db.keys()].filter(path => path.startsWith('images/'))).toHaveLength(0)
})

test('an older in-flight refresh cannot hide a newly committed record', async ({ page }) => {
  const api = await mockGitHub(page)
  await page.goto('/')
  await connect(page)
  const paused = api.pauseNextTree()
  await page.locator('.panel-foot').getByRole('button', { name: 'Refresh', exact: true }).click()
  await paused.began
  await navigate(page, 'Add record')
  const form = await fillOrder(page, 'Concurrent Customer')
  await form.getByRole('button', { name: 'Save record', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Record saved.' })).toBeVisible()
  paused.resume()
  await paused.done
  await page.waitForTimeout(200) // Let the deliberately stale request finish applying, if the guard is broken.
  await expect(page.locator('tbody tr')).toHaveCount(2)
  await expect(page.getByRole('button', { name: /View Concurrent Customer record/ })).toBeVisible()
})

test('closing a pending connection cancels it instead of authenticating in the background', async ({ page }) => {
  const api = await mockGitHub(page)
  const paused = api.pauseNextAccess()
  await page.goto('/')
  await page.getByRole('button', { name: 'Set up this phone', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Repository owner').fill('family')
  await dialog.getByLabel('Data repository', { exact: true }).fill('press-data')
  await dialog.getByLabel('Fine-grained personal access token').fill(TOKEN)
  await dialog.getByLabel('Keep this phone connected', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Connect to GitHub', exact: true }).click()
  await paused.began
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  paused.resume()
  await paused.done
  await page.waitForTimeout(200) // A canceled connection must stay canceled after its delayed response.
  expect(api.calls).toHaveLength(1)
  await expect(page.getByText('Not connected', { exact: true })).toBeVisible()
  await expect(page.getByText('Ready', { exact: true })).toHaveCount(0)
  expect(api.writes).toHaveLength(0)
  expect(await inspectSavedDevice(page)).toBeNull()
})

test('an edit cannot be closed while its commit confirmation is pending', async ({ page }) => {
  const api = await mockGitHub(page)
  await page.goto('/')
  await connect(page)
  await page.getByRole('button', { name: 'View Demo Stationery record old-1', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Edit', exact: true }).click()
  const edit = page.getByRole('dialog')
  await edit.getByLabel('Number of books', { exact: true }).fill('21')
  const paused = api.pauseNextWrite()
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click()
  await paused.began
  await page.keyboard.press('Escape')
  await expect(edit).toBeVisible()
  await expect(edit.getByLabel('Number of books', { exact: true })).toBeDisabled()
  paused.resume()
  await expect(edit).not.toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Changes saved.' })).toBeVisible()
  expect(api.writes).toHaveLength(1)
})

test('offline entry is retained without a GitHub write and can be saved after reconnecting', async ({ page }) => {
  const api = await mockGitHub(page, [])
  await page.goto('/')
  await connect(page)
  await navigate(page, 'Add record')
  const form = await fillOrder(page, 'Offline Customer')
  await page.context().setOffline(true)
  await expect(page.getByText('Offline', { exact: true })).toBeVisible()
  await form.getByRole('button', { name: 'Save record', exact: true }).click()
  await expect(form.getByRole('alert')).toContainText('offline')
  await expect(form.getByLabel('Customer name', { exact: true })).toHaveValue('Offline Customer')
  expect(api.writes).toHaveLength(0)
  await page.context().setOffline(false)
  await form.getByRole('button', { name: 'Save record', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Record saved.' })).toBeVisible()
  expect(api.writes).toHaveLength(1)
})

test('daily screens keep setup fields and backup controls in the separate device setup area', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.desktop-nav').getByRole('button')).toHaveText(['Home', 'Add record', 'All records', 'Customers'])
  for (const label of ['Add record', 'All records', 'Customers', 'Home']) {
    await navigate(page, label)
    await expect(page.getByLabel('Repository owner')).toHaveCount(0)
    await expect(page.getByLabel('Fine-grained personal access token')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Export JSON', exact: true })).toHaveCount(0)
  }
  await page.getByRole('button', { name: 'Open device setup', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Device setup.', exact: true })).toBeVisible()
  await expect(page.getByLabel('Fine-grained personal access token')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export JSON', exact: true })).not.toBeVisible()
  await page.getByText('Backup & advanced options', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Export JSON', exact: true })).toBeVisible()
})

// These inspect only the fictional test credential's browser storage, never a live token.
async function inspectSavedDevice(page: Page) {
  return page.evaluate(async () => {
    if (!(await indexedDB.databases()).some(database => database.name === 'pressbook-trusted-device-v1')) return null
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('pressbook-trusted-device-v1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      if (!database.objectStoreNames.contains('access')) return null
      return await new Promise<{ extractable: boolean; algorithm: string; ivBytes: number; encryptedText: string } | null>((resolve, reject) => {
        const transaction = database.transaction('access', 'readonly')
        const request = transaction.objectStore('access').get('github')
        request.onsuccess = () => {
          const entry = request.result
          resolve(entry ? { extractable: entry.key.extractable, algorithm: entry.key.algorithm.name, ivBytes: entry.iv.byteLength, encryptedText: new TextDecoder().decode(entry.ciphertext) } : null)
        }
        request.onerror = () => reject(request.error)
      })
    } finally { database.close() }
  })
}

test('a trusted phone reopens its records without a daily token field or app login', async ({ page }) => {
  const api = await mockGitHub(page)
  await page.goto('/')
  await connect(page, true)
  const remembered = await inspectSavedDevice(page)
  expect(remembered).not.toBeNull()
  expect(remembered!.extractable).toBe(false)
  expect(remembered!.algorithm).toBe('AES-GCM')
  expect(remembered!.ivBytes).toBe(12)
  expect(remembered!.encryptedText).not.toContain(TOKEN)
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(TOKEN)
  await page.reload()
  await expect(page.getByText('Ready', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'View Demo Stationery record old-1', exact: true })).toBeVisible()
  await expect(page.getByLabel('Fine-grained personal access token')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel(/password|PIN/i)).toHaveCount(0)
  expect(api.writes).toHaveLength(0)
})

test('forgetting a trusted phone clears its other open tabs and prevents automatic reconnection', async ({ page }) => {
  const api = await mockGitHub(page)
  await page.goto('/')
  await connect(page, true)
  const other = await page.context().newPage()
  const otherApi = await mockGitHub(other)
  await other.goto('/')
  await expect(other.getByText('Ready', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open device setup', exact: true }).click()
  page.on('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Forget this phone', exact: true }).click()
  await expect(page.getByText('Not connected', { exact: true })).toBeVisible()
  await expect(other.getByText('Not connected', { exact: true })).toBeVisible()
  await expect(other.getByRole('button', { name: 'View Demo Stationery record old-1', exact: true })).toHaveCount(0)
  expect(await inspectSavedDevice(page)).toBeNull()
  const callsBefore = otherApi.calls.length
  await other.reload()
  await expect(other.getByText('Not connected', { exact: true })).toBeVisible()
  await expect(other.getByText('Ready', { exact: true })).toHaveCount(0)
  expect(otherApi.calls).toHaveLength(callsBefore)
  expect(api.writes).toHaveLength(0)
  expect(otherApi.writes).toHaveLength(0)
  await other.close()
})

test('a damaged saved connection returns to setup without sending an unusable token to GitHub', async ({ page }) => {
  const api = await mockGitHub(page)
  await page.goto('/')
  await connect(page, true)
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('pressbook-trusted-device-v1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('access', 'readwrite')
        const store = transaction.objectStore('access'), request = store.get('github')
        request.onsuccess = () => store.put({ ...request.result, ciphertext: new Uint8Array([1, 2, 3]).buffer }, 'github')
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
    } finally { database.close() }
  })
  const callsBefore = api.calls.length
  await page.reload()
  await expect(page.getByText('Not connected', { exact: true })).toBeVisible()
  await expect(page.getByText('Ready', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText(/setup|set up|reconnect|connect again/i)
  expect(api.calls).toHaveLength(callsBefore)
  expect(api.writes).toHaveLength(0)
})

test('a rejected token is not remembered even when trusted-phone setup was requested', async ({ page }) => {
  const api = await mockGitHub(page)
  api.rejectAuthentication()
  await page.goto('/')
  await page.getByRole('button', { name: 'Set up this phone', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Repository owner').fill('family')
  await dialog.getByLabel('Data repository', { exact: true }).fill('press-data')
  await dialog.getByLabel('Fine-grained personal access token').fill(TOKEN)
  await dialog.getByLabel('Keep this phone connected', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Connect to GitHub', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('rejected this token')
  expect(await inspectSavedDevice(page)).toBeNull()
  const callsBefore = api.calls.length
  await page.reload()
  await expect(page.getByText('Not connected', { exact: true })).toBeVisible()
  expect(api.calls).toHaveLength(callsBefore)
  expect(api.writes).toHaveLength(0)
})
