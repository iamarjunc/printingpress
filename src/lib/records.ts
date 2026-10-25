import type { PrintingRecord } from "../types";

export const ADDED_BY = ["Chandrakumar", "Sreelekha", "Appu", "Akku"] as const;
export const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-IN");
export const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-IN").format(value);
export const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
export const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));

export function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function validDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Preserve the device's current local time on the chosen local diary date. */
export function creationTimestamp(dateKey: string, now = new Date()): string {
  if (!validDateKey(dateKey)) throw new Error("Choose a valid creation date.");
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(now);
  date.setFullYear(year, month - 1, day);
  // An exotic timezone may skip a whole local date. Never silently change it.
  if (localDateKey(date) !== dateKey)
    throw new Error(
      "This date is unavailable in the device time zone. Choose another date.",
    );
  return date.toISOString();
}

export function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/,
  );
  return (
    !!match &&
    validDateKey(match[1]) &&
    Number(match[2]) < 24 &&
    Number(match[3]) < 60 &&
    Number(match[4]) < 60 &&
    (!match[5] || (Number(match[6]) < 24 && Number(match[7]) < 60)) &&
    Number.isFinite(Date.parse(value))
  );
}

export function safePhotoPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^images\/[\w-]+\/[\w-]+\/[\w.-]+\.(?:jpe?g|png|webp)$/i.test(value) &&
    !value.includes("..")
  );
}

/** Structural validation only; historical oddities are warnings, never silent corrections. */
export function validateRecord(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return ["Record must be a JSON object."];
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of ["id", "customer_name", "bill_type", "added_by"]) {
    if (typeof record[key] !== "string" || !(record[key] as string).trim())
      errors.push(`${key} is required.`);
  }
  for (const key of ["start_no", "end_no", "pages", "books"]) {
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 1)
      errors.push(`${key} must be a positive whole number.`);
  }
  if (
    typeof record.start_no === "number" &&
    typeof record.end_no === "number" &&
    record.end_no < record.start_no
  )
    errors.push("End number cannot be smaller than start number.");
  if (!validTimestamp(record.created_at))
    errors.push("created_at must include a valid time zone.");
  if (record.updated_at != null && !validTimestamp(record.updated_at))
    errors.push("updated_at must include a valid time zone.");
  if (!validDateKey(record.date_key))
    errors.push("date_key must be a valid YYYY-MM-DD date.");
  if (record.photo_path != null && !safePhotoPath(record.photo_path))
    errors.push("photo_path must be a supported file under images/.");
  if (typeof record.is_legacy !== "boolean")
    errors.push("is_legacy must be true or false.");
  return errors;
}

export function parseRecord(value: unknown): PrintingRecord {
  const errors = validateRecord(value);
  if (errors.length) throw new Error(errors.join(" "));
  const record = value as PrintingRecord;
  return {
    ...record,
    updated_at: record.updated_at ?? null,
    photo_path: record.photo_path ?? null,
  };
}

/** Deterministic for a given record, making a retried create target the same file. */
export function recordPath(record: PrintingRecord): string {
  const timestamp = new Date(record.created_at).toISOString();
  const suffix = /^[\w-]+$/.test(record.id)
    ? record.id
    : Array.from(new TextEncoder().encode(record.id), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
  return `records/${timestamp.slice(0, 4)}/${timestamp.slice(5, 7)}/${timestamp.replace(/:/g, "-")}_${suffix}.json`;
}

export function recordWarnings(
  record: PrintingRecord,
  existing: PrintingRecord[],
): string[] {
  const warnings: string[] = [];
  const serials = record.end_no - record.start_no + 1;
  if (serials !== record.pages * record.books)
    warnings.push(
      "The number range differs from pages × books. This can be correct for duplicate copies or other printing formats; please check the entry.",
    );
  if (!ADDED_BY.some((name) => name === record.added_by))
    warnings.push(
      `“${record.added_by}” is a historical name outside the current family list. It has been preserved.`,
    );
  if (new Date(record.created_at).getTime() > Date.now() + 5 * 60_000)
    warnings.push(
      "The creation date is in the future. Please check the device clock or diary date.",
    );
  const matches = existing.filter(
    (other) =>
      other.id !== record.id &&
      normalize(other.customer_name) === normalize(record.customer_name) &&
      normalize(other.bill_type) === normalize(record.bill_type),
  );
  const overlaps = matches.filter(
    (other) =>
      record.start_no <= other.end_no && record.end_no >= other.start_no,
  );
  if (overlaps.length) {
    const exact = overlaps.some(
      (other) =>
        other.start_no === record.start_no &&
        other.end_no === record.end_no &&
        other.pages === record.pages &&
        other.books === record.books,
    );
    warnings.push(
      exact
        ? "A matching order already has this range, pages and books. Check whether this is a duplicate or an intentional reprint."
        : "This range overlaps a previous order for the same customer and bill type. Confirm that this is intentional.",
    );
  }
  return warnings;
}

export function matchesSearch(record: PrintingRecord, query: string): boolean {
  const term = normalize(query);
  if (!term) return true;
  if (
    normalize(record.customer_name).includes(term) ||
    normalize(record.bill_type).includes(term)
  )
    return true;
  const stripped = term.replace(/,/g, "");
  if (/^\d+$/.test(stripped)) {
    const number = Number(stripped);
    return number >= record.start_no && number <= record.end_no;
  }
  return `${record.start_no} ${record.end_no}`.includes(term);
}

export function customerNames(records: PrintingRecord[]): string[] {
  const names = new Map<string, string>();
  for (const record of records)
    if (!names.has(normalize(record.customer_name)))
      names.set(normalize(record.customer_name), record.customer_name);
  return [...names.values()].sort((a, b) => a.localeCompare(b, "en-IN"));
}
