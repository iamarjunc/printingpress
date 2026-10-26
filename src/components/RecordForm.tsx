import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { PrintingRecord, StoredRecord } from "../types";
import {
  ADDED_BY,
  creationTimestamp,
  formatDate,
  formatNumber,
  localDateKey,
  normalize,
  recordWarnings,
} from "../lib/records";
import { compressImage } from "../lib/images";
import { GitHubError } from "../lib/github";
import { Icon } from "./Icon";

interface RecordFormProps {
  records: StoredRecord[];
  initial?: StoredRecord;
  onSave: (record: PrintingRecord, photoChange?: Blob | null) => Promise<void>;
  onCancel: () => void;
  connected: boolean;
  onConnect: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
  onReloadLatest?: () => Promise<StoredRecord>;
}

interface FormValues {
  customer: string;
  billType: string;
  start: string;
  end: string;
  pages: string;
  books: string;
  addedBy: string;
  date: string;
}

type FieldErrors = Partial<Record<keyof FormValues, string>>;

function initialValues(record?: PrintingRecord): FormValues {
  return {
    customer: record?.customer_name ?? "",
    billType: record?.bill_type ?? "",
    start: record ? String(record.start_no) : "",
    end: record ? String(record.end_no) : "",
    pages: record ? String(record.pages) : "",
    books: record ? String(record.books) : "",
    addedBy: record?.added_by ?? "",
    date: record?.date_key ?? localDateKey(),
  };
}

function validate(values: FormValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.customer.trim()) errors.customer = "Enter a customer name.";
  if (!values.billType.trim()) errors.billType = "Enter a bill type.";
  if (!values.addedBy)
    errors.addedBy = "Select the person entering this record.";
  const labels = {
    start: "start number",
    end: "end number",
    pages: "pages",
    books: "number of books",
  };
  for (const key of ["start", "end", "pages", "books"] as const) {
    const value = Number(values[key]);
    if (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(value) || value < 1)
      errors[key] = `Enter a positive whole number for ${labels[key]}.`;
  }
  if (!errors.start && !errors.end && Number(values.end) < Number(values.start))
    errors.end = "End number must be equal to or greater than start number.";
  try {
    creationTimestamp(values.date);
  } catch {
    errors.date = "Choose a valid creation date.";
  }
  return errors;
}

function UploadIcon() {
  return (
    <svg
      width="23"
      height="23"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path
        d="M12 16V4m-4 4 4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RecordForm({
  records,
  initial,
  onSave,
  onCancel,
  connected,
  onConnect,
  onDirtyChange,
  onSavingChange,
  onReloadLatest,
}: RecordFormProps) {
  const id = useId();
  const [values, setValues] = useState<FormValues>(() =>
    initialValues(initial?.record),
  );
  const originalValues = useRef(JSON.stringify(initialValues(initial?.record)));
  const draftId = useRef(initial?.record.id ?? crypto.randomUUID());
  const attemptedTimestamp = useRef<string | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState("");
  const [photoError, setPhotoError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [compressing, setCompressing] = useState(false);
  const [photoChange, setPhotoChange] = useState<Blob | null | undefined>(
    undefined,
  );
  const [photoPreview, setPhotoPreview] = useState<string | undefined>(
    undefined,
  );
  const [submitted, setSubmitted] = useState(false);
  const [rangeSuggestion, setRangeSuggestion] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [latestRevision, setLatestRevision] = useState<
    StoredRecord | undefined
  >(undefined);
  const [reviewedLatest, setReviewedLatest] = useState(false);
  const [reloadingLatest, setReloadingLatest] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const dirty =
    !submitted &&
    (JSON.stringify(values) !== originalValues.current ||
      photoChange !== undefined);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (!(photoChange instanceof Blob)) {
      setPhotoPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(photoChange);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photoChange]);

  const customerOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const { record } of records)
      if (!map.has(normalize(record.customer_name)))
        map.set(normalize(record.customer_name), record.customer_name);
    return [...map.values()].sort((a, b) => a.localeCompare(b, "en-IN"));
  }, [records]);
  const billTypes = useMemo(
    () =>
      [...new Set(records.map(({ record }) => record.bill_type))].sort((a, b) =>
        a.localeCompare(b, "en-IN"),
      ),
    [records],
  );
  const matchingCustomers = customerOptions.filter(
    (name) =>
      values.customer.trim() &&
      normalize(name).includes(normalize(values.customer)),
  );
  const history = useMemo(
    () =>
      records
        .filter(
          ({ record }) =>
            normalize(record.customer_name) === normalize(values.customer),
        )
        .sort(
          (a, b) =>
            Date.parse(b.record.created_at) - Date.parse(a.record.created_at),
        ),
    [records, values.customer],
  );
  const billHistory = history.filter(
    ({ record }) => normalize(record.bill_type) === normalize(values.billType),
  );
  const lastMatchingOrder = billHistory.find(
    ({ record }) => record.id !== initial?.record.id,
  )?.record;
  let selectedTimestamp = new Date().toISOString();
  try {
    selectedTimestamp = creationTimestamp(values.date);
  } catch {
    /* The field error is shown on submit. */
  }
  const candidate: PrintingRecord = {
    id: draftId.current,
    customer_name: values.customer.trim(),
    bill_type: values.billType.trim(),
    start_no: Number(values.start),
    end_no: Number(values.end),
    pages: Number(values.pages),
    books: Number(values.books),
    added_by: values.addedBy,
    created_at:
      initial?.record.created_at ??
      attemptedTimestamp.current ??
      selectedTimestamp,
    updated_at: initial ? new Date().toISOString() : null,
    date_key: values.date,
    photo_path: initial?.record.photo_path ?? null,
    is_legacy: initial?.record.is_legacy ?? false,
  };
  const warnings =
    Object.keys(validate(values)).length === 0
      ? recordWarnings(
          candidate,
          records.map(({ record }) => record),
        )
      : [];

  function update(key: keyof FormValues, value: string) {
    setValues((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => ({ ...previous, [key]: undefined }));
    if (key === "customer" || key === "billType") setRangeSuggestion(false);
    setSubmitted(false);
  }

  async function selectPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPhotoError("");
    setCompressing(true);
    try {
      setPhotoChange(await compressImage(file));
      setSubmitted(false);
    } catch (error) {
      setPhotoError(
        error instanceof Error
          ? error.message
          : "The image could not be prepared. Please try another photo.",
      );
    } finally {
      setCompressing(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current || compressing) return;
    if (conflict && !reviewedLatest) {
      setSaveError(
        "Review the latest version before retrying. Your entered changes are still here.",
      );
      return;
    }
    const nextErrors = validate(values);
    setErrors(nextErrors);
    setSaveError("");
    if (Object.keys(nextErrors).length) {
      requestAnimationFrame(() =>
        formRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus(),
      );
      return;
    }
    if (!connected) {
      setSaveError(
        "Connect this phone before saving. Your entry is still here.",
      );
      return;
    }
    savingRef.current = true;
    setSaving(true);
    onSavingChange?.(true);
    try {
      attemptedTimestamp.current ??=
        initial?.record.created_at ?? creationTimestamp(values.date);
      setAttempted(true);
      await onSave(
        {
          ...candidate,
          created_at: attemptedTimestamp.current,
          updated_at: initial ? new Date().toISOString() : null,
        },
        photoChange,
      );
      setSubmitted(true);
      onDirtyChange?.(false);
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "The save was not confirmed. Your entry has been kept. Check your internet connection and try again.",
      );
      if (
        error instanceof GitHubError &&
        error.kind === "conflict" &&
        initial &&
        onReloadLatest
      ) {
        setConflict(true);
        setLatestRevision(undefined);
        setReviewedLatest(false);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
      onSavingChange?.(false);
    }
  }

  async function reloadLatest() {
    if (!onReloadLatest || reloadingLatest || savingRef.current) return;
    setReloadingLatest(true);
    setReviewedLatest(false);
    try {
      const latest = await onReloadLatest();
      // The parent updates the SHA without remounting this form. Keep every
      // entered field and pending photo while the user reviews the new base.
      setLatestRevision(latest);
      attemptedTimestamp.current = latest.record.created_at;
      setSaveError("");
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "The latest version could not be loaded. Your changes are still here.",
      );
    } finally {
      setReloadingLatest(false);
    }
  }

  const inputProps = (key: keyof FormValues) => ({
    id: `${id}-${key}`,
    name: key,
    value: values[key],
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      update(key, event.target.value),
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `${id}-${key}-error` : undefined,
    disabled: saving,
  });
  const fieldError = (key: keyof FormValues) =>
    errors[key] ? (
      <span id={`${id}-${key}-error`} className="field-error">
        {errors[key]}
      </span>
    ) : null;

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="record-form">
      <div className="record-form-layout">
        <div className="record-form-main">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Order details</h2>
                <p className="muted">The essentials, all in one place.</p>
              </div>
              <span className="required-note">All fields required</span>
            </div>
            <div className="form-grid">
              <div className="field field-wide">
                <label htmlFor={`${id}-customer`}>Customer name</label>
                <input
                  {...inputProps("customer")}
                  className="input"
                  placeholder="e.g. City Electronics"
                  list={`${id}-customers`}
                  autoComplete="off"
                  required
                  maxLength={250}
                />
                <datalist id={`${id}-customers`}>
                  {customerOptions.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                {fieldError("customer")}
                {matchingCustomers.length > 0 && !history.length && (
                  <div
                    className="customer-suggestions"
                    aria-label="Matching customers"
                  >
                    <span className="muted">Existing customers:</span>
                    {matchingCustomers.slice(0, 5).map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="suggestion-chip"
                        onClick={() => update("customer", name)}
                        disabled={saving}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="field field-wide">
                <label htmlFor={`${id}-billType`}>Bill type</label>
                <input
                  {...inputProps("billType")}
                  className="input"
                  placeholder="e.g. Invoice, Receipt, Estimate"
                  list={`${id}-bills`}
                  autoComplete="off"
                  required
                  maxLength={250}
                />
                <datalist id={`${id}-bills`}>
                  {billTypes.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                {fieldError("billType")}
              </div>
              {(["start", "end", "pages", "books"] as const).map((key) => (
                <div key={key} className="field">
                  <label htmlFor={`${id}-${key}`}>
                    {
                      {
                        start: "Start number",
                        end: "End number",
                        pages: "Pages per book",
                        books: "Number of books",
                      }[key]
                    }
                  </label>
                  <input
                    {...inputProps(key)}
                    className="input"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    placeholder={
                      { start: "1", end: "2000", pages: "50", books: "40" }[key]
                    }
                    required
                  />
                  {fieldError(key)}
                </div>
              ))}
              <div className="field">
                <label htmlFor={`${id}-addedBy`}>Added by</label>
                <select
                  {...inputProps("addedBy")}
                  className="input select"
                  required
                >
                  <option value="">Select family member</option>
                  {initial &&
                    !ADDED_BY.some(
                      (name) => name === initial.record.added_by,
                    ) && (
                      <option value={initial.record.added_by}>
                        {initial.record.added_by} (historical)
                      </option>
                    )}
                  {ADDED_BY.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                {fieldError("addedBy")}
              </div>
              <div className="field">
                <label htmlFor={`${id}-date`}>Created date</label>
                <input
                  {...inputProps("date")}
                  className="input"
                  type="date"
                  required
                  disabled={saving || Boolean(initial) || attempted}
                />
                {fieldError("date")}
                <span className="field-help">
                  {initial
                    ? "Original creation date is preserved."
                    : attempted
                      ? "Date kept fixed so a retry uses the same record."
                      : "Entering a diary record? Choose its original date."}
                </span>
              </div>
            </div>
            <div className="form-time-note">
              <span className="status-dot" />
              {initial ? (
                <>
                  Created {formatDate(initial.record.created_at)}. Edits receive
                  a separate update timestamp.
                </>
              ) : (
                <>
                  Time is recorded automatically when you save, in your device’s
                  local time zone.
                </>
              )}
            </div>
          </section>

          <section className="panel photo-section">
            <div className="panel-head">
              <div>
                <h2>
                  Reference photo{" "}
                  <span className="optional-label">Optional</span>
                </h2>
                <p className="muted">
                  A bill book, handwritten note, or sample print.
                </p>
              </div>
            </div>
            <div className="photo-upload-area">
              {photoPreview ? (
                <div className="photo-preview-row">
                  <img
                    className="photo-preview"
                    src={photoPreview}
                    alt="Reference photo preview"
                  />
                  <div>
                    <strong>Photo ready to attach</strong>
                    <p className="muted">
                      {photoChange instanceof Blob
                        ? `${Math.ceil(photoChange.size / 1024)} KB · Compressed for storage`
                        : ""}
                    </p>
                  </div>
                </div>
              ) : initial?.record.photo_path && photoChange !== null ? (
                <div className="photo-preview-row">
                  <div className="photo-placeholder">
                    <UploadIcon />
                  </div>
                  <div>
                    <strong>Existing reference photo</strong>
                    <p className="muted">
                      This photo will be kept unless you remove or replace it.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="upload-icon">
                    <UploadIcon />
                  </div>
                  <strong>
                    {photoChange === null
                      ? "Photo marked for removal"
                      : "Keep a sample with your record"}
                  </strong>
                  <p className="muted">
                    JPEG, PNG or WebP · Up to 12 MB · Automatically compressed
                  </p>
                </>
              )}
              <div className="photo-actions">
                <label
                  className={`btn btn-secondary file-button${saving || compressing ? " is-disabled" : ""}`}
                >
                  {compressing
                    ? "Preparing photo…"
                    : photoPreview ||
                        (initial?.record.photo_path && photoChange !== null)
                      ? "Replace photo"
                      : "Choose photo"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={selectPhoto}
                    disabled={saving || compressing}
                    aria-label="Choose reference photo"
                  />
                </label>
                <label
                  className={`btn btn-ghost file-button camera-button${saving || compressing ? " is-disabled" : ""}`}
                >
                  Take photo
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    onChange={selectPhoto}
                    disabled={saving || compressing}
                    aria-label="Take reference photo"
                  />
                </label>
                {(photoPreview ||
                  (initial?.record.photo_path && photoChange !== null)) && (
                  <button
                    type="button"
                    className="btn btn-ghost danger-text"
                    disabled={saving || compressing}
                    onClick={() => {
                      setPhotoChange(
                        initial?.record.photo_path ? null : undefined,
                      );
                      setPhotoError("");
                    }}
                  >
                    Remove photo
                  </button>
                )}
                {initial?.record.photo_path && photoChange !== undefined && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={saving || compressing}
                    onClick={() => {
                      setPhotoChange(undefined);
                      setPhotoError("");
                    }}
                  >
                    Keep original photo
                  </button>
                )}
              </div>
              {photoError && (
                <p role="alert" className="field-error">
                  {photoError}
                </p>
              )}
            </div>
          </section>
        </div>

        <aside className="record-form-side">
          <section className="panel history-panel">
            <div className="panel-head">
              <div>
                <span className="eyebrow">A useful look back</span>
                <h2>Customer history</h2>
              </div>
              {history.length > 0 && (
                <span className="pill">
                  {history.length} {history.length === 1 ? "order" : "orders"}
                </span>
              )}
            </div>
            {history.length ? (
              <>
                <p className="history-customer">
                  {history[0].record.customer_name}
                </p>
                <p className="muted">
                  Previous ranges help you avoid reusing serial numbers.
                </p>
                <div className="history-list">
                  {history.map(({ record, path }) => (
                    <div key={path} className="history-entry">
                      <div className="history-entry-heading">
                        <strong>{record.bill_type}</strong>
                        <span className="muted">
                          {formatDate(record.created_at)}
                        </span>
                      </div>
                      <p className="history-range">
                        {formatNumber(record.start_no)}{" "}
                        <span aria-label="to">→</span>{" "}
                        {formatNumber(record.end_no)}
                      </p>
                      <span className="muted">
                        {formatNumber(record.books)} books · {record.added_by}
                      </span>
                    </div>
                  ))}
                </div>
                {lastMatchingOrder && !initial && (
                  <div className="range-suggestion">
                    {!rangeSuggestion ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setRangeSuggestion(true)}
                        disabled={
                          saving ||
                          lastMatchingOrder.end_no >= Number.MAX_SAFE_INTEGER
                        }
                      >
                        Suggest next start number
                      </button>
                    ) : (
                      <>
                        <p>
                          Last {lastMatchingOrder.bill_type.toLowerCase()} ended
                          at{" "}
                          <strong>
                            {formatNumber(lastMatchingOrder.end_no)}
                          </strong>
                          . Use{" "}
                          <strong>
                            {formatNumber(lastMatchingOrder.end_no + 1)}
                          </strong>{" "}
                          as the start number?
                        </p>
                        <p className="field-help">
                          Check the diary first. Gaps and reprints can be
                          intentional.
                        </p>
                        <div className="photo-actions">
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              update(
                                "start",
                                String(lastMatchingOrder.end_no + 1),
                              );
                              setRangeSuggestion(false);
                            }}
                            disabled={saving}
                          >
                            Use {formatNumber(lastMatchingOrder.end_no + 1)}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => setRangeSuggestion(false)}
                            disabled={saving}
                          >
                            Dismiss
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="history-empty">
                <div className="history-empty-mark" aria-hidden="true">
                  <Icon name="book" size={19} />
                </div>
                <h3>
                  {values.customer.trim()
                    ? "No previous orders yet"
                    : "Previous printing orders"}
                </h3>
                <p className="muted">
                  {values.customer.trim()
                    ? "No previous orders match this name. Select an existing customer suggestion to see their printing history."
                    : "Choose an existing customer to see their previous orders and last printed number ranges here."}
                </p>
              </div>
            )}
          </section>
          <div className="form-assurance">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7z" />
              <path d="m8 12 3 3 5-6" />
            </svg>
            <p>Wait for “Record saved” before closing this page.</p>
          </div>
        </aside>
      </div>

      <div aria-live="polite" className="form-feedback">
        {warnings.length > 0 && (
          <div className="notice notice-warning">
            <strong>Please double-check</strong>
            <ul>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <p>
              These are reminders. Intentional reprints and different book
              formats are allowed.
            </p>
          </div>
        )}
        {conflict && (
          <div className="notice notice-warning">
            <strong>
              {latestRevision
                ? "Latest version loaded — your entered changes are kept"
                : "A newer version of this record is available"}
            </strong>
            {latestRevision ? (
              <>
                <p>
                  <strong>{latestRevision.record.customer_name}</strong> ·{" "}
                  {latestRevision.record.bill_type}
                </p>
                <p>
                  Current range:{" "}
                  <strong>
                    {formatNumber(latestRevision.record.start_no)} →{" "}
                    {formatNumber(latestRevision.record.end_no)}
                  </strong>{" "}
                  · {formatNumber(latestRevision.record.pages)} pages ·{" "}
                  <strong>
                    {formatNumber(latestRevision.record.books)} books
                  </strong>
                </p>
                <p>
                  Last updated:{" "}
                  {new Date(
                    latestRevision.record.updated_at ??
                      latestRevision.record.created_at,
                  ).toLocaleString()}{" "}
                  · Added by {latestRevision.record.added_by}
                </p>
                <p>
                  Compare these details with your entry above. Saving your
                  changes will replace the current record values.
                </p>
                {reviewedLatest ? (
                  <p>
                    <strong>Reviewed. You can now save your changes.</strong>
                  </p>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setReviewedLatest(true);
                      setSaveError("");
                    }}
                    disabled={reloadingLatest}
                  >
                    I reviewed the latest version
                  </button>
                )}
              </>
            ) : (
              <p>
                Load the latest version and review it before saving. Your
                entered details and photo will be kept.
              </p>
            )}
            <div className="photo-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={reloadLatest}
                disabled={reloadingLatest || saving || !connected}
              >
                {reloadingLatest
                  ? "Loading latest version…"
                  : latestRevision
                    ? "Check latest again"
                    : "Review latest version"}
              </button>
            </div>
          </div>
        )}
        {saveError && (
          <div className="notice notice-error" role="alert">
            <strong>Save not confirmed</strong>
            <p>{saveError}</p>
            <p>
              Your entered details have been kept. After a network interruption,
              refresh records before starting a different order.
            </p>
          </div>
        )}
        {!connected && (
          <div className="notice notice-info">
            <div>
              <strong>This phone needs to be connected</strong>
              <p>
                Your entry is kept here. A family member can set up this phone
                so records can be opened and saved.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onConnect}
              disabled={saving}
            >
              Set up this phone
            </button>
          </div>
        )}
      </div>
      <div className="form-footer">
        <span className="muted">
          {saving
            ? "Saving… Please keep this page open."
            : dirty
              ? "Unsaved entry · Keep this page open"
              : "Check the details, then save your record."}
        </span>
        <div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={saving || reloadingLatest}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              saving ||
              compressing ||
              reloadingLatest ||
              !connected ||
              (conflict && !reviewedLatest)
            }
          >
            {saving ? (
              <>
                <span className="spinner" aria-hidden="true" /> Saving record…
              </>
            ) : initial ? (
              "Save changes"
            ) : (
              "Save record"
            )}
          </button>
        </div>
      </div>
    </form>
  );
}
