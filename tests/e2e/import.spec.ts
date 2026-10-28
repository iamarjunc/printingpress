import { expect, test, type Page, type Route } from "@playwright/test";
import { prepareImport } from "../../src/lib/import";

const TOKEN = "github_pat_fictional_import_test_token";
const legacyRows = [
  {
    id: "fictional-archive-a",
    customer_name: "Demo Harbour Supplies",
    bill_type: "മാതൃക Receipt",
    start_no: 1,
    end_no: 300,
    pages: 50,
    books: 7,
    added_by: "Chandrakumar",
    created_at: "2021-06-11T09:20:30.123456+00:00",
    date_key: "2021-06-11",
    is_legacy: true,
  },
  {
    id: "fictional-archive-b",
    customer_name: "DEMO HARBOUR SUPPLIES",
    bill_type: "മാതൃക Receipt",
    start_no: 1,
    end_no: 300,
    pages: 50,
    books: 7,
    added_by: "Akku",
    created_at: "2021-06-11T09:20:31.654321+00:00",
    date_key: "2021-06-11",
    is_legacy: true,
  },
];
const originalBytes = Buffer.from(`${JSON.stringify(legacyRows, null, 2)}\n`);
interface FakeFile {
  sha: string;
  content: Buffer;
}

async function mockImportGitHub(page: Page, isPrivate = true) {
  let revision = 1;
  const nextSha = () => (revision++).toString(16).padStart(40, "0");
  const files = new Map<string, FakeFile>();
  const writes: {
    method: string;
    path: string;
    body: Record<string, unknown>;
  }[] = [];
  const calls: { method: string; path: string }[] = [];
  let loseConfirmationFor: string | null = null;
  await page.route("https://api.github.com/**", async (route: Route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    expect(url.origin).toBe("https://api.github.com");
    expect(request.headers().authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.url()).not.toContain(TOKEN);
    const path = decodeURIComponent(
      url.pathname.replace("/repos/family/press-data", ""),
    );
    calls.push({ method, path });
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "")
      return respond({ private: isPrivate, permissions: { push: true } });
    if (path === "/commits/main")
      return respond({
        sha: revision.toString(16).padStart(40, "c"),
        commit: { tree: { sha: revision.toString(16).padStart(40, "d") } },
      });
    if (path === "/branches/main")
      return respond({
        name: "main",
        commit: { sha: revision.toString(16).padStart(40, "e") },
      });
    if (path.startsWith("/git/trees/"))
      return respond({
        truncated: false,
        tree: [...files]
          .filter(([key]) => key.startsWith("records/"))
          .map(([key, value]) => ({ path: key, type: "blob", sha: value.sha })),
      });
    if (path.startsWith("/git/blobs/")) {
      const file = [...files.values()].find(
        (value) => value.sha === path.slice("/git/blobs/".length),
      );
      return file
        ? respond({
            encoding: "base64",
            content: file.content.toString("base64"),
          })
        : respond({ message: "Not Found" }, 404);
    }
    if (path.startsWith("/contents/")) {
      const key = path.slice("/contents/".length),
        current = files.get(key);
      if (method === "GET")
        return current
          ? respond({
              type: "file",
              path: key,
              sha: current.sha,
              encoding: "base64",
              content: current.content.toString("base64"),
            })
          : respond({ message: "Not Found" }, 404);
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method, path: key, body });
      if (method !== "PUT")
        throw new Error(`Unexpected migration mutation ${method}`);
      if (current)
        return respond({ message: "File already exists; SHA required" }, 422);
      expect(body.branch).toBe("main");
      expect(body.sha).toBeUndefined();
      const file = {
        sha: nextSha(),
        content: Buffer.from(String(body.content), "base64"),
      };
      files.set(key, file);
      if (loseConfirmationFor === key) {
        loseConfirmationFor = null;
        return route.abort("failed");
      }
      return respond(
        { content: { sha: file.sha, path: key }, commit: { sha: nextSha() } },
        201,
      );
    }
    throw new Error(
      `Unhandled mocked import request ${method} ${url.pathname}`,
    );
  });
  return {
    files,
    writes,
    calls,
    seed: (path: string, content: Buffer) =>
      files.set(path, { sha: nextSha(), content }),
    loseConfirmationFor: (path: string) => {
      loseConfirmationFor = path;
    },
  };
}

async function fillConnection(page: Page, remember = false) {
  await page
    .getByRole("button", { name: "Set up this phone", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Repository owner").fill("family");
  await dialog
    .getByLabel("Data repository", { exact: true })
    .fill("press-data");
  await dialog.getByLabel("Branch").fill("main");
  await dialog.getByLabel("Fine-grained personal access token").fill(TOKEN);
  if (remember)
    await dialog
      .getByLabel("Keep this phone connected", { exact: true })
      .check();
  await dialog
    .getByRole("button", { name: "Connect to GitHub", exact: true })
    .click();
  return dialog;
}
async function openImporter(page: Page) {
  await page
    .getByRole("button", { name: "Open device setup", exact: true })
    .click();
  const section = page.getByRole("region", {
    name: "Import old records",
    exact: true,
  });
  await expect(section).toBeVisible();
  return section;
}
async function chooseOriginal(page: Page) {
  await page
    .getByLabel("Choose old records JSON", { exact: true })
    .setInputFiles({
      name: "legacy_data.json",
      mimeType: "application/json",
      buffer: originalBytes,
    });
  await expect(
    page.getByRole("button", { name: "Import 2 records", exact: true }),
  ).toBeEnabled();
}
async function savedCredentialExists(page: Page) {
  return page.evaluate(async () => {
    if (
      !(await indexedDB.databases()).some(
        (db) => db.name === "pressbook-trusted-device-v1",
      )
    )
      return false;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("pressbook-trusted-device-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains("access")) return false;
      return await new Promise<boolean>((resolve, reject) => {
        const request = database
          .transaction("access", "readonly")
          .objectStore("access")
          .get("github");
        request.onsuccess = () => resolve(request.result !== undefined);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

test("public website repositories cannot be connected or remembered as private record storage", async ({
  page,
}) => {
  const api = await mockImportGitHub(page, false);
  await page.goto("/");
  const dialog = await fillConnection(page, true);
  await expect(dialog.getByRole("alert")).toContainText(/private/i);
  await expect(page.getByText("Ready", { exact: true })).toHaveCount(0);
  expect(
    api.calls.every((call) => call.method === "GET" && call.path === ""),
  ).toBe(true);
  expect(api.writes).toHaveLength(0);
  expect(await savedCredentialExists(page)).toBe(false);
});

test("old JSON records are previewed, imported privately with their exact backup, and safely skipped on rerun", async ({
  page,
}) => {
  const api = await mockImportGitHub(page);
  const plan = await prepareImport(originalBytes);
  await page.goto("/");
  await fillConnection(page);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  let importer = await openImporter(page);
  await chooseOriginal(page);
  expect(api.writes).toHaveLength(0);
  await expect(importer).toContainText(/2/);
  await expect(importer).toContainText(/warning|review/i);
  await importer
    .getByRole("button", { name: "Import 2 records", exact: true })
    .click();
  await expect(importer.getByRole("status")).toContainText("Import complete");
  expect(api.writes).toHaveLength(4);
  expect(api.writes[0].path).toBe("backups/legacy_data.json");
  expect(
    api.files.get("backups/legacy_data.json")!.content.equals(originalBytes),
  ).toBe(true);
  for (const [index, entry] of plan.entries.entries()) {
    const actual = JSON.parse(api.files.get(entry.path)!.content.toString());
    expect(actual).toEqual({
      ...legacyRows[index],
      updated_at: null,
      photo_path: null,
    });
    expect(actual.created_at).toBe(legacyRows[index].created_at);
  }
  const report = JSON.parse(
    api.files.get("backups/migration-report.json")!.content.toString(),
  );
  expect(report.imported_count).toBe(2);
  expect(report.rejected).toEqual([]);
  await page
    .locator(".desktop-nav")
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await expect(
    page.locator(".stat-card").nth(0).locator(".stat-value"),
  ).toHaveText("2");
  await expect(
    page.locator(".stat-card").nth(1).locator(".stat-value"),
  ).toHaveText("1");
  await expect(
    page.locator(".stat-card").nth(2).locator(".stat-value"),
  ).toHaveText("14");
  importer = await openImporter(page);
  await chooseOriginal(page);
  await importer
    .getByRole("button", { name: "Import 2 records", exact: true })
    .click();
  await expect(importer.getByRole("status")).toContainText("Import complete");
  expect(api.writes).toHaveLength(4);
  expect(
    [...api.files.keys()].filter((key) => key.startsWith("records/")),
  ).toHaveLength(2);
});

test("a changed historical file is never overwritten and the selected import remains available for review", async ({
  page,
}) => {
  const api = await mockImportGitHub(page);
  const plan = await prepareImport(originalBytes);
  const protectedPath = plan.entries[1].path;
  const different = Buffer.from(
    JSON.stringify({ ...plan.entries[1].record, books: 9 }),
  );
  api.seed(protectedPath, different);
  await page.goto("/");
  await fillConnection(page);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  const importer = await openImporter(page);
  await chooseOriginal(page);
  await importer
    .getByRole("button", { name: "Import 2 records", exact: true })
    .click();
  await expect(importer.getByRole("alert")).toContainText(
    /overwrite|different|conflict/i,
  );
  await expect(
    importer.getByRole("status").filter({ hasText: "Import complete" }),
  ).toHaveCount(0);
  await expect(
    importer.getByRole("button", { name: "Import 2 records", exact: true }),
  ).toBeEnabled();
  expect(api.files.get(protectedPath)!.content.equals(different)).toBe(true);
  expect(api.writes.some((write) => write.path === protectedPath)).toBe(false);
});

test("an interrupted import reports uncertainty and retries the same paths without duplicate records", async ({
  page,
}) => {
  const api = await mockImportGitHub(page);
  const plan = await prepareImport(originalBytes);
  api.loseConfirmationFor(plan.entries[0].path);
  await page.goto("/");
  await fillConnection(page);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  const importer = await openImporter(page);
  await chooseOriginal(page);
  await importer
    .getByRole("button", { name: "Import 2 records", exact: true })
    .click();
  await expect(importer.getByRole("alert")).toContainText(
    /not confirmed|interrupted|stopped|retry|reached|may have/i,
  );
  await expect(
    importer.getByRole("status").filter({ hasText: "Import complete" }),
  ).toHaveCount(0);
  expect(api.files.has("backups/legacy_data.json")).toBe(true);
  expect(api.files.has(plan.entries[0].path)).toBe(true);
  await expect(
    importer.getByRole("button", { name: "Import 2 records", exact: true }),
  ).toBeEnabled();
  await importer
    .getByRole("button", { name: "Import 2 records", exact: true })
    .click();
  await expect(importer.getByRole("status")).toContainText("Import complete");
  expect(
    [...api.files.keys()].filter((key) => key.startsWith("records/")),
  ).toHaveLength(2);
  expect(
    api.writes.filter((write) => write.path === plan.entries[0].path),
  ).toHaveLength(1);
  expect(api.writes).toHaveLength(4);
});
