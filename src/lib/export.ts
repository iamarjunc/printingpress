import type { PrintingRecord } from "../types";
export function recordsCsv(records: PrintingRecord[]): string {
  const keys: (keyof PrintingRecord)[] = [
    "id",
    "customer_name",
    "bill_type",
    "start_no",
    "end_no",
    "pages",
    "books",
    "added_by",
    "created_at",
    "updated_at",
    "date_key",
    "photo_path",
    "is_legacy",
  ];
  const cell = (value: unknown) => {
    let text = value == null ? "" : String(value);
    if (typeof value === "string" && /^[\s]*[=+@-]/.test(text))
      text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return (
    "\uFEFF" +
    [
      keys.join(","),
      ...records.map((record) =>
        keys.map((key) => cell(record[key])).join(","),
      ),
    ].join("\r\n")
  );
}
export function downloadRecords(
  records: PrintingRecord[],
  format: "json" | "csv",
) {
  const blob = new Blob(
    [
      format === "json"
        ? JSON.stringify(records, null, 2)
        : recordsCsv(records),
    ],
    {
      type:
        format === "json"
          ? "application/json;charset=utf-8"
          : "text/csv;charset=utf-8",
    },
  );
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = `pressbook-${new Date().toISOString().slice(0, 10)}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
