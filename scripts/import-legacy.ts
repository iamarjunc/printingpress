import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeMigration } from "./import-lib.ts";
import { uploadMigration } from "./import-github.ts";

const args = process.argv.slice(2);
const allowedFlags = new Set([
  "--input",
  "--output",
  "--owner",
  "--repo",
  "--branch",
  "--upload",
  "--help",
]);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!allowedFlags.has(arg)) throw new Error(`Unknown argument: ${arg}`);
  if (!["--upload", "--help"].includes(arg)) {
    if (!args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error(`${arg} needs a value.`);
    i++;
  }
}
const option = (name: string, fallback?: string) => {
  const position = args.indexOf(name);
  return position === -1 ? fallback : args[position + 1];
};
if (args.includes("--help")) {
  console.log(
    "Usage: npm run import:legacy -- --input legacy_data.json [--output .private-data] [--upload --owner OWNER --repo PRIVATE_REPO --branch main]",
  );
  console.log(
    "Upload reads PRIVATE_DATA_TOKEN from the process environment. Never put tokens in command arguments.",
  );
  process.exit(0);
}

function safeName(value: string | undefined, label: string): string {
  if (!value || !/^[A-Za-z0-9_.-]+$/.test(value))
    throw new Error(`${label} must be a GitHub owner or repository name.`);
  return value;
}

async function main() {
  const input = option("--input");
  if (!input)
    throw new Error(
      "--input is required. Use the actual legacy export; this app never bundles business data into the frontend.",
    );
  const result = await writeMigration(
    input,
    option("--output", ".private-data")!,
  );
  console.log(
    `Prepared ${result.plan.entries.length}/${result.plan.sourceCount} records: ${result.created} new, ${result.unchanged} unchanged.`,
  );
  console.log(`Exact original backup: ${result.backupPath}`);
  console.log(
    `Review report: ${join(result.output, "migration-report.json")} (${result.plan.warnings.length} warnings).`,
  );
  if (result.plan.rejected.length) {
    for (const rejected of result.plan.rejected)
      console.error(
        `Rejected row ${rejected.index}: ${rejected.errors.join(" ")}`,
      );
    console.error(
      "Valid records were prepared locally. Resolve rejected rows before uploading; the original remains unchanged.",
    );
    process.exitCode = 2;
    return;
  }
  if (!args.includes("--upload")) return;
  const owner = safeName(option("--owner"), "--owner");
  const repo = safeName(option("--repo"), "--repo");
  const branch = option("--branch", "main")!;
  const token = process.env.PRIVATE_DATA_TOKEN;
  if (!token?.trim())
    throw new Error(
      "Set PRIVATE_DATA_TOKEN securely in the process environment before using --upload.",
    );
  const files = [
    ...result.plan.entries.map(({ path, content }) => ({
      path,
      bytes: Buffer.from(content),
    })),
    {
      path: "backups/legacy_data.json",
      bytes: await readFile(result.backupPath),
    },
    {
      path: "backups/migration-report.json",
      bytes: await readFile(join(result.output, "migration-report.json")),
    },
  ];
  const { uploaded, skipped } = await uploadMigration({
    owner,
    repo,
    branch,
    token,
    files,
    onCommit: (path) => console.log(`Committed ${path}`),
  });
  console.log(
    `Private repository import confirmed: ${uploaded} committed files, ${skipped} identical files skipped.`,
  );
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Migration failed. No success was assumed.",
  );
  process.exitCode = 1;
});
