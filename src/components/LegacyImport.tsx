import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import {
  MAX_IMPORT_BYTES,
  prepareImport,
  type PreparedImport,
} from "../lib/import";
import { Icon } from "./Icon";

interface LegacyImportProps {
  connected: boolean;
  privateRepository: boolean;
  disabled?: boolean;
  onImport: (
    plan: PreparedImport,
    onProgress: (done: number, total: number, skipped: number) => void,
  ) => Promise<{ uploaded: number; skipped: number }>;
  onSetup?: () => void;
}

interface ImportProgress {
  done: number;
  total: number;
  skipped: number;
}

const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-IN").format(value);

export function LegacyImport({
  connected,
  privateRepository,
  disabled = false,
  onImport,
  onSetup,
}: LegacyImportProps) {
  const headingId = useId();
  const hintId = useId();
  const [filename, setFilename] = useState("");
  const [plan, setPlan] = useState<PreparedImport | null>(null);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState<ImportProgress>({
    done: 0,
    total: 0,
    skipped: 0,
  });
  const sequence = useRef(0);
  const importInFlight = useRef(false);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const busy = disabled || parsing || importing;
  const allowed = connected && privateRepository;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    if (connected && privateRepository) return;
    sequence.current++;
    setFilename("");
    setPlan(null);
    setError("");
    setComplete(false);
    setParsing(false);
    setImporting(false);
    importInFlight.current = false;
    setProgress({ done: 0, total: 0, skipped: 0 });
    if (input.current) input.current.value = "";
  }, [connected, privateRepository]);
  useEffect(() => {
    if (!importing) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [importing]);

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || busy || !allowed) return;
    const attempt = ++sequence.current;
    setFilename(file.name);
    setPlan(null);
    setComplete(false);
    setError("");
    setProgress({ done: 0, total: 0, skipped: 0 });
    if (!file.size || file.size > MAX_IMPORT_BYTES) {
      setError(
        file.size
          ? "Choose a JSON export smaller than 5 MB. Use the command-line importer for larger files."
          : "This file is empty. Choose the original JSON export.",
      );
      return;
    }
    setParsing(true);
    try {
      const prepared = await prepareImport(
        new Uint8Array(await file.arrayBuffer()),
      );
      if (alive.current && attempt === sequence.current) setPlan(prepared);
    } catch (cause) {
      if (alive.current && attempt === sequence.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "This file could not be opened. Choose the original JSON export.",
        );
    } finally {
      if (alive.current && attempt === sequence.current) setParsing(false);
    }
  }

  async function importRecords() {
    if (
      !plan ||
      !allowed ||
      busy ||
      importInFlight.current ||
      !plan.entries.length ||
      plan.rejected.length
    )
      return;
    importInFlight.current = true;
    const attempt = sequence.current;
    setImporting(true);
    setError("");
    setComplete(false);
    setProgress({ done: 0, total: plan.files.length, skipped: 0 });
    try {
      await onImport(plan, (done, total, skipped) => {
        if (alive.current && attempt === sequence.current)
          setProgress({ done, total, skipped });
      });
      if (alive.current && attempt === sequence.current) {
        setComplete(true);
        setProgress((previous) => ({
          ...previous,
          done: plan.files.length,
          total: plan.files.length,
        }));
      }
    } catch (cause) {
      if (alive.current && attempt === sequence.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The import was not confirmed. Keep the same file selected and try again when the connection is restored.",
        );
    } finally {
      if (alive.current && attempt === sequence.current) {
        importInFlight.current = false;
        setImporting(false);
      }
    }
  }

  function clearFile() {
    if (busy) return;
    sequence.current++;
    setFilename("");
    setPlan(null);
    setError("");
    setComplete(false);
    setProgress({ done: 0, total: 0, skipped: 0 });
    if (input.current) input.current.value = "";
  }

  return (
    <section
      className="panel legacy-import"
      role="region"
      aria-labelledby={headingId}
    >
      <div className="panel-head">
        <div>
          <h2 id={headingId}>
            <Icon name="file" size={20} />
            Import old records
          </h2>
          <p>
            Bring the records from your old application into this record book.
          </p>
        </div>
      </div>
      <div className="settings-body">
        {!connected ? (
          <div className="notice notice-warning">
            <div>
              <strong>Connect the private data repository first.</strong>
              <p>
                Use Device setup to connect the repository that will hold your
                family’s records.
              </p>
              {onSetup && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onSetup}
                  disabled={disabled}
                >
                  Set up this phone
                </button>
              )}
            </div>
          </div>
        ) : !privateRepository ? (
          <div className="notice notice-error" role="alert">
            <span>
              Import is blocked for public repositories. Connect your private
              data repository before importing business records.
            </span>
          </div>
        ) : null}
        <label className="field">
          Choose your original export
          <input
            ref={input}
            className="input"
            type="file"
            accept=".json,application/json"
            aria-label="Choose old records JSON"
            aria-describedby={hintId}
            disabled={busy || !allowed}
            onChange={chooseFile}
          />
        </label>
        <p className="field-hint" id={hintId}>
          Select the original legacy_data.json file. Choosing a file only
          prepares a preview; nothing is uploaded until you confirm. Up to 5 MB
          and 5,000 records.
        </p>
        {parsing && (
          <p className="import-progress" role="status">
            <span className="spinner" /> Preparing your records…
          </p>
        )}
        {plan && (
          <div className="import-preview">
            <p>
              <strong>{filename}</strong>
            </p>
            <dl className="import-preview-stats">
              <div>
                <dt>Records</dt>
                <dd>{formatNumber(plan.entries.length)}</dd>
              </div>
              <div>
                <dt>Customers</dt>
                <dd>{formatNumber(plan.uniqueCustomers)}</dd>
              </div>
              <div>
                <dt>Books</dt>
                <dd>{formatNumber(plan.totalBooks)}</dd>
              </div>
            </dl>
            <p className="muted">
              Original names, creation dates, IDs and historical entries are
              kept. The original export will also be backed up in the private
              repository when you import. Apparently duplicate rows are
              preserved for review.
            </p>
            {plan.rejected.length > 0 && (
              <div className="notice notice-error" role="alert">
                <div>
                  <strong>
                    {formatNumber(plan.rejected.length)}{" "}
                    {plan.rejected.length === 1
                      ? "record needs"
                      : "records need"}{" "}
                    correction before importing.
                  </strong>
                  <p>
                    No files will be uploaded until these rows are resolved.
                  </p>
                  <ul>
                    {plan.rejected.slice(0, 20).map((row) => (
                      <li key={row.index}>
                        Row {row.index}: {row.errors.join(" ")}
                      </li>
                    ))}
                  </ul>
                  {plan.rejected.length > 20 && (
                    <p>
                      {formatNumber(plan.rejected.length - 20)} more rows are
                      listed in the prepared review report. Use the command-line
                      importer to inspect a larger report.
                    </p>
                  )}
                </div>
              </div>
            )}
            {plan.warnings.length > 0 && (
              <details className="import-review">
                <summary>
                  Review {formatNumber(plan.warnings.length)} historical{" "}
                  {plan.warnings.length === 1 ? "warning" : "warnings"}
                </summary>
                <p className="field-hint">
                  These warnings do not automatically correct or remove any
                  historical entry.
                </p>
                <ul>
                  {plan.warnings.slice(0, 50).map((warning, index) => (
                    <li key={`${warning.code}-${index}`}>{warning.message}</li>
                  ))}
                </ul>
                {plan.warnings.length > 50 && (
                  <p className="field-hint">
                    The remaining {formatNumber(plan.warnings.length - 50)}{" "}
                    warnings will be kept with the private review report.
                  </p>
                )}
              </details>
            )}
            {!plan.entries.length && !plan.rejected.length && (
              <p className="notice notice-warning">
                No records were found in this file.
              </p>
            )}
            {complete ? (
              <div className="notice notice-success" role="status">
                <Icon name="check" size={18} />
                <span>
                  <strong>Import complete.</strong> Your{" "}
                  {formatNumber(plan.entries.length)} historical{" "}
                  {plan.entries.length === 1 ? "record is" : "records are"} now
                  available. Rerunning the same unchanged file skips already
                  imported files without creating duplicates.
                </span>
              </div>
            ) : (
              <div className="import-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void importRecords()}
                  disabled={
                    busy ||
                    !allowed ||
                    !plan.entries.length ||
                    plan.rejected.length > 0
                  }
                >
                  {importing ? (
                    <>
                      <span className="spinner" />
                      Importing…
                    </>
                  ) : (
                    `Import ${plan.entries.length} ${plan.entries.length === 1 ? "record" : "records"}`
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={clearFile}
                >
                  Choose another file
                </button>
              </div>
            )}
          </div>
        )}
        {importing && (
          <div className="import-progress" role="status">
            <progress
              max={progress.total || 1}
              value={progress.done}
              aria-label="Confirmed import progress"
            />
            <p>
              {formatNumber(progress.done)} of {formatNumber(progress.total)}{" "}
              files confirmed. Keep this page open.
            </p>
          </div>
        )}
        {error && (
          <div className="notice notice-error" role="alert">
            <div>
              <strong>
                {plan ? "Import not confirmed" : "File could not be prepared"}
              </strong>
              <p>{error}</p>
              {plan && (
                <p>
                  {progress.done
                    ? `${formatNumber(progress.done)} file${progress.done === 1 ? " was" : "s were"} confirmed before the interruption. `
                    : ""}
                  The same file is still selected. Retry it to safely resume;
                  matching files are skipped and different existing files are
                  never overwritten.
                </p>
              )}
            </div>
          </div>
        )}
        {complete && (
          <div className="import-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={clearFile}
            >
              Choose another file
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
