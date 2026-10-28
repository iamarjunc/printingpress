import { ADDED_BY, normalize, validateRecord } from "./records";

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_RECORDS = 5_000;
const MAX_IMPORT_WARNINGS = 20_000;

/**
 * Browser port of the CLI's deterministic migration planner. Compatibility
 * tests keep filenames, original values and report bytes equal to the CLI.
 * Preparing an import never performs a network request or changes records.
 */
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

async function digest(value: string | Uint8Array): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const result = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Array.from(new Uint8Array(result), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
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
async function buildMigration(input: unknown): Promise<MigrationPlan> {
  if (!Array.isArray(input))
    throw new Error("Legacy input must be a JSON array of records.");
  if (input.length > MAX_IMPORT_RECORDS)
    throw new Error(
      "This export has more than 5,000 records. Use the command-line importer for larger files.",
    );
  const plan: MigrationPlan = {
    sourceCount: input.length,
    entries: [],
    rejected: [],
    warnings: [],
    totalBooks: 0,
    uniqueCustomers: 0,
  };
  const addWarning = (warning: MigrationWarning) => {
    if (plan.warnings.length >= MAX_IMPORT_WARNINGS)
      throw new Error(
        "This export contains too many overlapping or duplicate rows to review safely in the browser. Use the command-line importer for this file.",
      );
    plan.warnings.push(warning);
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
    const rowDigest = await digest(canonical(row));
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
    // Browser imports must also be readable by the app after the commit.
    const structuralErrors = validateRecord(record);
    if (structuralErrors.length) {
      plan.rejected.push({
        index: index + 1,
        id: row.id,
        errors: structuralErrors,
      });
      continue;
    }
    const utc = new Date(record.created_at).toISOString();
    const suffix = (await digest(`${id}:${rowDigest}:${occurrence}`)).slice(
      0,
      20,
    );
    const path = `records/${utc.slice(0, 4)}/${utc.slice(5, 7)}/${utc.replace(/[:.]/g, "-")}_legacy-${suffix}.json`;
    plan.entries.push({
      path,
      content: `${JSON.stringify(record, null, 2)}\n`,
      record,
    });
    if (row.id == null || String(row.id) === "")
      addWarning({
        code: "generated-id",
        ids: [id],
        message: `Row ${index + 1} had no ID; a deterministic ID was generated.`,
      });
    if (typeof row.id === "number")
      addWarning({
        code: "numeric-id",
        ids: [id],
        message: `ID ${id} was represented as text for the application's record schema.`,
      });
    if (!ADDED_BY.some((name) => name === record.added_by))
      addWarning({
        code: "historical-person",
        ids: [id],
        message: `Historical added_by value “${record.added_by}” was preserved.`,
      });
    const expected = (record.end_no - record.start_no + 1) / record.pages;
    if (expected !== record.books)
      addWarning({
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
      addWarning({
        code: "duplicate-id",
        ids: [id],
        message: `${entries.length} original rows share ID ${id}; each row was retained as a separate file.`,
      });
  for (const names of byName.values())
    if (names.size > 1)
      addWarning({
        code: "customer-spelling",
        ids: [],
        message: `Case/spacing variants are grouped in search without rewriting original names: ${[...names].join(" / ")}.`,
      });
  const matchKeys = plan.entries.map(({ record }) => ({
    customer: normalize(record.customer_name),
    bill: normalize(record.bill_type),
  }));
  for (let i = 0; i < plan.entries.length; i++) {
    const a = plan.entries[i].record;
    for (let j = i + 1; j < plan.entries.length; j++) {
      const b = plan.entries[j].record;
      if (
        matchKeys[i].customer === matchKeys[j].customer &&
        matchKeys[i].bill === matchKeys[j].bill &&
        a.start_no <= b.end_no &&
        b.start_no <= a.end_no
      ) {
        const duplicate =
          a.start_no === b.start_no &&
          a.end_no === b.end_no &&
          a.pages === b.pages &&
          a.books === b.books;
        addWarning({
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

export interface ImportFile {
  path: string;
  bytes: Uint8Array;
}

export interface MigrationReport {
  source_sha256: string;
  source_count: number;
  imported_count: number;
  rejected: MigrationPlan["rejected"];
  total_books: number;
  unique_customers: number;
  warnings: MigrationWarning[];
  files: { path: string; id: string }[];
  note: string;
}

export interface PreparedImport extends MigrationPlan {
  backupBytes: Uint8Array;
  report: MigrationReport;
  files: ImportFile[];
}

/** Parse a private JSON export in memory and prepare exact, resumable files. */
export async function prepareImport(
  bytes: Uint8Array,
): Promise<PreparedImport> {
  if (!bytes.byteLength)
    throw new Error("This file is empty. Choose the original JSON export.");
  if (bytes.byteLength > MAX_IMPORT_BYTES)
    throw new Error(
      "Choose a JSON export smaller than 5 MB. Use the command-line importer for larger files.",
    );
  // Own the backup bytes so later edits to a caller's buffer cannot alter it.
  const backupBytes = new Uint8Array(bytes);
  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(backupBytes),
    );
  } catch {
    throw new Error(
      "This is not a valid UTF-8 JSON export. Choose the original legacy_data.json file.",
    );
  }
  const plan = await buildMigration(input);
  const report: MigrationReport = {
    source_sha256: await digest(backupBytes),
    source_count: plan.sourceCount,
    imported_count: plan.entries.length,
    rejected: plan.rejected,
    total_books: plan.totalBooks,
    unique_customers: plan.uniqueCustomers,
    warnings: plan.warnings,
    files: plan.entries.map(({ path, record }) => ({ path, id: record.id })),
    note: "Original customer names, timestamps, IDs, historical entries and is_legacy flags are preserved. No suspicious records were silently merged or corrected.",
  };
  const encode = (value: string) => new TextEncoder().encode(value);
  const files: ImportFile[] = [
    // Preserve the exact original before committing independent record files.
    { path: "backups/legacy_data.json", bytes: backupBytes },
    ...plan.entries.map(({ path, content }) => ({
      path,
      bytes: encode(content),
    })),
    {
      path: "backups/migration-report.json",
      bytes: encode(`${JSON.stringify(report, null, 2)}\n`),
    },
  ];
  return { ...plan, backupBytes, report, files };
}
