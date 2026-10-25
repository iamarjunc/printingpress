import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface MigratedRecord extends Record<string, unknown> {
  id: string;
  customer_name: string;
  bill_type: string;
  start_no: number;
  end_no: number;
  pages: number;
  books: number;
  added_by: string;
  created_at: string;
  updated_at: string | null;
  date_key: string;
  photo_path: string | null;
  is_legacy: boolean;
}
export interface MigrationEntry {
  path: string;
  content: string;
  record: MigratedRecord;
}
export interface MigrationWarning {
  code: string;
  message: string;
  ids: string[];
}
export interface MigrationPlan {
  sourceCount: number;
  entries: MigrationEntry[];
  rejected: { index: number; id?: unknown; errors: string[] }[];
  warnings: MigrationWarning[];
  totalBooks: number;
  uniqueCustomers: number;
}

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-IN");
function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  calendarDate(value.slice(0, 10)) &&
  Number.isFinite(Date.parse(value));
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Build a deterministic plan without changing historical values or deduplicating rows. */
export function buildMigration(input: unknown): MigrationPlan {
  if (!Array.isArray(input))
    throw new Error("Legacy input must be a JSON array of records.");
  const plan: MigrationPlan = {
    sourceCount: input.length,
    entries: [],
    rejected: [],
    warnings: [],
    totalBooks: 0,
    uniqueCustomers: 0,
  };
  const occurrences = new Map<string, number>();
  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      plan.rejected.push({
        index: index + 1,
        errors: ["Record must be a JSON object."],
      });
      continue;
    }
    const row = item as Record<string, unknown>;
    const errors: string[] = [];
    for (const field of ["customer_name", "bill_type", "added_by"]) {
      if (typeof row[field] !== "string" || !String(row[field]).trim())
        errors.push(`${field} must be nonempty text.`);
    }
    for (const field of ["start_no", "end_no", "pages", "books"]) {
      if (!Number.isSafeInteger(row[field]) || Number(row[field]) <= 0)
        errors.push(`${field} must be a positive safe integer.`);
    }
    if (Number(row.end_no) < Number(row.start_no))
      errors.push("end_no is smaller than start_no.");
    if (!timestamp(row.created_at))
      errors.push(
        "created_at must be an unambiguous timestamp with a timezone.",
      );
    if (row.updated_at != null && !timestamp(row.updated_at))
      errors.push("updated_at is not a valid timestamp.");
    if (
      row.date_key != null &&
      (typeof row.date_key !== "string" || !calendarDate(row.date_key))
    )
      errors.push("date_key must be YYYY-MM-DD.");
    if (row.photo_path != null && typeof row.photo_path !== "string")
      errors.push("photo_path must be text or null.");
    if (row.is_legacy != null && typeof row.is_legacy !== "boolean")
      errors.push("is_legacy must be a boolean.");
    if (row.id != null && !["string", "number"].includes(typeof row.id))
      errors.push("id must be text or a number when provided.");
    if (errors.length) {
      plan.rejected.push({ index: index + 1, id: row.id, errors });
      continue;
    }
    const rowDigest = digest(canonical(row));
    const occurrence = (occurrences.get(rowDigest) ?? 0) + 1;
    occurrences.set(rowDigest, occurrence);
    const id =
      row.id == null || String(row.id) === ""
        ? `legacy-${rowDigest.slice(0, 16)}-${occurrence}`
        : String(row.id);
    const record = {
      ...row,
      id,
      created_at: row.created_at,
      updated_at: row.updated_at ?? null,
      date_key: row.date_key ?? (row.created_at as string).slice(0, 10),
      photo_path: row.photo_path ?? null,
      is_legacy: row.is_legacy ?? true,
    } as MigratedRecord;
    const utc = new Date(record.created_at).toISOString();
    const suffix = digest(`${id}:${rowDigest}:${occurrence}`).slice(0, 20);
    const path = `records/${utc.slice(0, 4)}/${utc.slice(5, 7)}/${utc.replace(/[:.]/g, "-")}_legacy-${suffix}.json`;
    plan.entries.push({
      path,
      content: `${JSON.stringify(record, null, 2)}\n`,
      record,
    });
    if (row.id == null || String(row.id) === "")
      plan.warnings.push({
        code: "generated-id",
        ids: [id],
        message: `Row ${index + 1} had no ID; a deterministic ID was generated.`,
      });
    if (typeof row.id === "number")
      plan.warnings.push({
        code: "numeric-id",
        ids: [id],
        message: `ID ${id} was represented as text for the application's record schema.`,
      });
    if (
      !["Chandrakumar", "Sreelekha", "Appu", "Akku"].includes(record.added_by)
    )
      plan.warnings.push({
        code: "historical-person",
        ids: [id],
        message: `Historical added_by value “${record.added_by}” was preserved.`,
      });
    const expected = (record.end_no - record.start_no + 1) / record.pages;
    if (expected !== record.books)
      plan.warnings.push({
        code: "quantity-review",
        ids: [id],
        message: `ID ${id}: range/pages suggests ${expected} books while the original says ${record.books}. Values were preserved; copies or reprints may explain this.`,
      });
  }
  const byId = new Map<string, MigrationEntry[]>();
  const byName = new Map<string, Set<string>>();
  for (const entry of plan.entries) {
    const existing = byId.get(entry.record.id) ?? [];
    existing.push(entry);
    byId.set(entry.record.id, existing);
    const key = normalize(entry.record.customer_name);
    const names = byName.get(key) ?? new Set<string>();
    names.add(entry.record.customer_name);
    byName.set(key, names);
  }
  for (const [id, entries] of byId)
    if (entries.length > 1)
      plan.warnings.push({
        code: "duplicate-id",
        ids: [id],
        message: `${entries.length} original rows share ID ${id}; each row was retained as a separate file.`,
      });
  for (const names of byName.values())
    if (names.size > 1)
      plan.warnings.push({
        code: "customer-spelling",
        ids: [],
        message: `Case/spacing variants are grouped in search without rewriting original names: ${[...names].join(" / ")}.`,
      });
  for (let i = 0; i < plan.entries.length; i++) {
    const a = plan.entries[i].record;
    for (let j = i + 1; j < plan.entries.length; j++) {
      const b = plan.entries[j].record;
      if (
        normalize(a.customer_name) === normalize(b.customer_name) &&
        normalize(a.bill_type) === normalize(b.bill_type) &&
        a.start_no <= b.end_no &&
        b.start_no <= a.end_no
      ) {
        const duplicate =
          a.start_no === b.start_no &&
          a.end_no === b.end_no &&
          a.pages === b.pages &&
          a.books === b.books;
        plan.warnings.push({
          code: duplicate ? "possible-duplicate" : "overlapping-range",
          ids: [a.id, b.id],
          message: `IDs ${a.id} and ${b.id}: ${duplicate ? "matching order quantities and number ranges" : "overlapping number ranges"} for the same customer and bill type. Both records were preserved for review.`,
        });
      }
    }
  }
  plan.totalBooks = plan.entries.reduce(
    (sum, { record }) => sum + record.books,
    0,
  );
  plan.uniqueCustomers = byName.size;
  return plan;
}

async function writeExact(
  path: string,
  bytes: Buffer | string,
): Promise<"created" | "unchanged"> {
  const expected = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  try {
    const existing = await readFile(path);
    if (!existing.equals(expected))
      throw new Error(
        `Refusing to overwrite different existing content: ${path}`,
      );
    return "unchanged";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, expected, { flag: "wx", mode: 0o600 });
  return "created";
}

export async function writeMigration(inputPath: string, outputPath: string) {
  const original = await readFile(inputPath);
  const plan = buildMigration(JSON.parse(original.toString("utf8")));
  const output = resolve(outputPath);
  const backupPath = join(output, "backups", "legacy_data.json");
  await writeExact(backupPath, original);
  let created = 0;
  let unchanged = 0;
  for (const entry of plan.entries) {
    const outcome = await writeExact(join(output, entry.path), entry.content);
    if (outcome === "created") created++;
    else unchanged++;
  }
  const report = {
    source_sha256: digest(original),
    source_count: plan.sourceCount,
    imported_count: plan.entries.length,
    rejected: plan.rejected,
    total_books: plan.totalBooks,
    unique_customers: plan.uniqueCustomers,
    warnings: plan.warnings,
    files: plan.entries.map(({ path, record }) => ({ path, id: record.id })),
    note: "Original customer names, timestamps, IDs, historical entries and is_legacy flags are preserved. No suspicious records were silently merged or corrected.",
  };
  await writeExact(
    join(output, "migration-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return { plan, report, output, backupPath, created, unchanged };
}
