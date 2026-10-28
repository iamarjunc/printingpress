import type {
  GitHubConfig,
  LoadResult,
  PrintingRecord,
  StoredRecord,
} from "../types";
import {
  parseRecord,
  recordPath,
  safePhotoPath,
  validateRecord,
} from "./records";
import { MAX_COMPRESSED_IMAGE_BYTES } from "./images";

export interface ImportProgress {
  uploaded: number;
  skipped: number;
  total: number;
  path?: string;
}

export interface GitHubImportFile {
  path: string;
  bytes: Uint8Array;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly kind: string;
  readonly retryAt?: Date;
  readonly importProgress?: ImportProgress;
  constructor(
    message: string,
    status = 0,
    kind = "api",
    retryAt?: Date,
    importProgress?: ImportProgress,
  ) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.kind = kind;
    this.retryAt = retryAt;
    this.importProgress = importProgress;
  }
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}
interface TreeResult {
  tree: TreeEntry[];
  truncated: boolean;
}
interface ContentResult {
  sha: string;
  path: string;
  content?: string;
  encoding?: string;
  type?: string;
}
interface CommitResult {
  content?: { sha: string; path: string };
  commit?: { sha: string };
}
interface UploadedPhoto {
  path: string;
  sha: string;
  newlyUploaded: boolean;
}

const pathURL = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");
const isSha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);
const isRecordPath = (path: string) =>
  /^records\/(?:[\w.-]+\/)*[\w.%+-]+\.json$/i.test(path) &&
  !path.includes("..");

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192)
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(binary);
}
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function encodeJSON(record: PrintingRecord): string {
  return bytesToBase64(
    new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`),
  );
}
function sameRecord(left: PrintingRecord, right: PrintingRecord): boolean {
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
  return keys.every((key) => left[key] === right[key]);
}
async function blobSha(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const gitBlob = new Uint8Array(header.length + bytes.length);
  gitBlob.set(header);
  gitBlob.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", gitBlob);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** All credentials and private-record caches live only in this client instance. */
export class GitHubClient {
  private readonly config: GitHubConfig;
  private readonly base: string;
  private disconnected = false;
  private readonly requests = new Set<AbortController>();
  private readonly cache = new Map<string, StoredRecord>();
  private readonly issueCache = new Map<
    string,
    { sha: string; message: string }
  >();
  private readonly photoCache = new Map<string, { sha: string; blob: Blob }>();
  private writeQueue: Promise<unknown> = Promise.resolve();
  readonly warnings: string[] = [];

  constructor(config: GitHubConfig) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(config.owner))
      throw new GitHubError(
        "Enter a valid GitHub owner name.",
        0,
        "configuration",
      );
    if (
      !/^[A-Za-z0-9_.-]{1,100}$/.test(config.repo) ||
      [".", ".."].includes(config.repo)
    )
      throw new GitHubError(
        "Enter a repository name, without a URL or slashes.",
        0,
        "configuration",
      );
    if (
      !config.branch ||
      config.branch.length > 255 ||
      /[\x00-\x20\x7f~^:?*\[\\]/.test(config.branch) ||
      config.branch.includes("..") ||
      config.branch.includes("@{") ||
      config.branch.startsWith("/") ||
      config.branch.endsWith("/") ||
      config.branch.endsWith(".") ||
      config.branch.endsWith(".lock") ||
      config.branch.split("/").some((part) => !part || part.startsWith("."))
    )
      throw new GitHubError(
        "Enter a valid Git branch, such as main.",
        0,
        "configuration",
      );
    if (!config.token.trim() || /\s/.test(config.token.trim()))
      throw new GitHubError(
        "Enter a GitHub token without spaces.",
        0,
        "configuration",
      );
    this.config = { ...config, token: config.token.trim() };
    this.base = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  }

  disconnect(): void {
    this.disconnected = true;
    this.config.token = "";
    this.cache.clear();
    this.issueCache.clear();
    this.photoCache.clear();
    this.warnings.length = 0;
    for (const request of this.requests) request.abort();
    this.requests.clear();
  }

  private ensureActive(): void {
    if (this.disconnected)
      throw new GitHubError(
        "Disconnected. Reconnect and refresh before continuing.",
        0,
        "disconnected",
      );
  }

  private async request<T>(
    route: string,
    method: "GET" | "PUT" | "DELETE" = "GET",
    body?: unknown,
  ): Promise<T> {
    this.ensureActive();
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      let response: Response;
      try {
        response = await fetch(`https://api.github.com${this.base}${route}`, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.config.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
      } catch {
        this.ensureActive();
        throw new GitHubError(
          method === "GET"
            ? "Could not reach GitHub. Check your connection and try again."
            : "GitHub did not confirm the save. It may have reached the repository. Refresh before retrying; your entered data has been kept.",
          0,
          method === "GET" ? "network" : "uncertain",
        );
      }
      this.ensureActive();
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        this.ensureActive();
        throw new GitHubError(
          method === "GET"
            ? "GitHub returned an unreadable response. Try refreshing."
            : "GitHub did not return a commit confirmation. Refresh before retrying.",
          response.status,
          method === "GET" ? "invalid_response" : "uncertain",
        );
      }
      this.ensureActive();
      if (!response.ok) {
        const message =
          data && typeof data === "object" && "message" in data
            ? String(data.message)
            : "";
        const retryAfter = response.headers.get("retry-after");
        const reset = response.headers.get("x-ratelimit-reset");
        const rateLimited =
          response.status === 429 ||
          (response.status === 403 &&
            (response.headers.get("x-ratelimit-remaining") === "0" ||
              !!retryAfter ||
              /rate limit|abuse detection|secondary rate/i.test(message)));
        if (rateLimited) {
          const retryAt =
            retryAfter && /^\d+$/.test(retryAfter)
              ? new Date(Date.now() + Number(retryAfter) * 1000)
              : reset && /^\d+$/.test(reset)
                ? new Date(Number(reset) * 1000)
                : undefined;
          throw new GitHubError(
            `GitHub's request limit was reached.${retryAt ? ` Try again after ${retryAt.toLocaleTimeString()}.` : " Wait a few minutes before trying again."}`,
            response.status,
            "rate_limit",
            retryAt,
          );
        }
        if (response.status === 401)
          throw new GitHubError(
            "GitHub rejected this token. Check that it has not expired, then reconnect.",
            401,
            "authentication",
          );
        if (response.status === 403)
          throw new GitHubError(
            "GitHub denied access. Check repository access, Contents permissions, token approval and branch protection.",
            403,
            "permission",
          );
        if (response.status === 404)
          throw new GitHubError(
            "The repository, branch or file was not found. Check the settings and token repository access.",
            404,
            "not_found",
          );
        if (response.status === 409 && /Git Repository is empty/i.test(message))
          throw new GitHubError(
            "This data repository is empty. Initialize it with a README on the selected branch, then reconnect.",
            409,
            "uninitialized",
          );
        if (response.status === 409 || response.status === 422)
          throw new GitHubError(
            "GitHub could not accept this change. Another person may have changed the file, or branch rules may block direct commits. Refresh, review the latest record and try again.",
            response.status,
            "conflict",
          );
        if (response.status >= 500 && method !== "GET")
          throw new GitHubError(
            "GitHub did not confirm the change. It may have been committed. Refresh before retrying.",
            response.status,
            "uncertain",
          );
        throw new GitHubError(
          `GitHub returned an error (${response.status}). Your entered data has been kept.`,
          response.status,
          "api",
        );
      }
      return data as T;
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }

  async verifyAccess(): Promise<{ private: boolean; canWrite: boolean }> {
    const metadata = await this.request<{
      private: boolean;
      permissions?: { push?: boolean };
    }>("");
    if (typeof metadata.private !== "boolean")
      throw new GitHubError(
        "GitHub returned incomplete repository metadata.",
        0,
        "invalid_response",
      );
    return {
      private: metadata.private,
      canWrite: metadata.permissions?.push === true,
    };
  }

  private async content(path: string): Promise<ContentResult> {
    const result = await this.request<ContentResult>(
      `/contents/${pathURL(path)}?ref=${encodeURIComponent(this.config.branch)}`,
    );
    if (!result || !isSha(result.sha) || result.type === "dir")
      throw new GitHubError(
        "GitHub returned incomplete file metadata.",
        0,
        "invalid_response",
      );
    return result;
  }

  private parseContent(content: ContentResult): PrintingRecord {
    if (content.encoding !== "base64" || typeof content.content !== "string")
      throw new GitHubError(
        "GitHub did not return the record contents.",
        0,
        "invalid_response",
      );
    try {
      return parseRecord(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            decodeBase64(content.content),
          ),
        ),
      );
    } catch (error) {
      throw new GitHubError(
        `This record is invalid: ${error instanceof Error ? error.message : "unreadable JSON"}`,
        0,
        "invalid_record",
      );
    }
  }

  private async getRecordIfExists(path: string): Promise<StoredRecord | null> {
    try {
      const content = await this.content(path);
      return { record: this.parseContent(content), path, sha: content.sha };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  private async entries(treeSha: string): Promise<TreeEntry[]> {
    const result = await this.request<TreeResult>(
      `/git/trees/${treeSha}?recursive=1`,
    );
    if (!Array.isArray(result.tree))
      throw new GitHubError(
        "GitHub returned an invalid repository tree.",
        0,
        "invalid_response",
      );
    if (!result.truncated)
      return result.tree.filter(
        (entry) =>
          entry.type === "blob" &&
          entry.path.startsWith("records/") &&
          entry.path.endsWith(".json"),
      );
    // Never consume a truncated recursive list: traverse the complete records subtree.
    const root = await this.request<TreeResult>(`/git/trees/${treeSha}`);
    if (!Array.isArray(root.tree) || root.truncated)
      throw new GitHubError(
        "The root directory is too large to list safely. Split data into smaller directories.",
        0,
        "truncated",
      );
    const records = root.tree.find(
      (entry) => entry.type === "tree" && entry.path === "records",
    );
    if (!records) return [];
    const files: TreeEntry[] = [];
    const pending = [{ sha: records.sha, path: "records" }];
    while (pending.length) {
      this.ensureActive();
      const current = pending.shift()!;
      const subtree = await this.request<TreeResult>(
        `/git/trees/${current.sha}`,
      );
      if (!Array.isArray(subtree.tree) || subtree.truncated)
        throw new GitHubError(
          `The ${current.path} directory is too large to list safely. Split it into smaller directories.`,
          0,
          "truncated",
        );
      for (const entry of subtree.tree) {
        const path = `${current.path}/${entry.path}`;
        if (entry.type === "tree") pending.push({ sha: entry.sha, path });
        else if (entry.type === "blob" && path.endsWith(".json"))
          files.push({ ...entry, path });
      }
    }
    return files;
  }

  async loadRecords(_force = false): Promise<LoadResult> {
    const head = await this.request<{
      sha: string;
      commit: { tree: { sha: string } };
    }>(`/commits/${encodeURIComponent(this.config.branch)}`);
    if (!isSha(head.sha) || !isSha(head.commit?.tree?.sha))
      throw new GitHubError(
        "GitHub returned an incomplete branch response.",
        0,
        "invalid_response",
      );
    const entries = await this.entries(head.commit.tree.sha);
    const issues: string[] = [];
    const nextCache = new Map<string, StoredRecord>();
    let cursor = 0;
    const worker = async () => {
      while (cursor < entries.length) {
        const entry = entries[cursor++];
        if (!isRecordPath(entry.path) || !isSha(entry.sha)) {
          issues.push(
            `${entry.path}: unsupported record path or blob metadata. Review it in GitHub.`,
          );
          continue;
        }
        const cached = this.cache.get(entry.path);
        if (cached?.sha === entry.sha) {
          nextCache.set(entry.path, cached);
          continue;
        }
        const cachedIssue = this.issueCache.get(entry.path);
        if (cachedIssue?.sha === entry.sha) {
          issues.push(cachedIssue.message);
          continue;
        }
        const blob = await this.request<{ content: string; encoding: string }>(
          `/git/blobs/${entry.sha}`,
        );
        if (blob.encoding !== "base64" || typeof blob.content !== "string") {
          const message = `${entry.path}: GitHub did not return readable JSON content.`;
          this.issueCache.set(entry.path, { sha: entry.sha, message });
          issues.push(message);
          continue;
        }
        try {
          const record = parseRecord(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                decodeBase64(blob.content),
              ),
            ),
          );
          nextCache.set(entry.path, {
            record,
            path: entry.path,
            sha: entry.sha,
          });
          this.issueCache.delete(entry.path);
        } catch (error) {
          const message = `${entry.path}: ${error instanceof Error ? error.message : "invalid JSON"}`;
          this.issueCache.set(entry.path, { sha: entry.sha, message });
          issues.push(message);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(5, entries.length) }, worker),
    );
    this.ensureActive();
    this.cache.clear();
    const paths = new Set(entries.map((entry) => entry.path));
    for (const path of this.issueCache.keys())
      if (!paths.has(path)) this.issueCache.delete(path);
    for (const [path, stored] of nextCache) this.cache.set(path, stored);
    const records = [...nextCache.values()].sort(
      (left, right) =>
        Date.parse(right.record.created_at) -
        Date.parse(left.record.created_at),
    );
    const ids = new Set<string>();
    for (const stored of records) {
      if (ids.has(stored.record.id))
        issues.push(
          `${stored.path}: record ID ${stored.record.id} appears in more than one file. Both entries were preserved.`,
        );
      ids.add(stored.record.id);
    }
    return { records, issues, headSha: head.sha };
  }

  private async writeRecord(
    path: string,
    record: PrintingRecord,
    sha?: string,
  ): Promise<StoredRecord> {
    const result = await this.request<CommitResult>(
      `/contents/${pathURL(path)}`,
      "PUT",
      {
        message: `${sha ? "Update" : "Add"} printing record ${record.id}`,
        content: encodeJSON(record),
        branch: this.config.branch,
        ...(sha ? { sha } : {}),
      },
    );
    if (!isSha(result.commit?.sha) || !isSha(result.content?.sha))
      throw new GitHubError(
        "GitHub did not return a complete commit confirmation. Refresh before retrying.",
        0,
        "uncertain",
      );
    const stored = { record, path, sha: result.content!.sha };
    this.cache.set(path, stored);
    return stored;
  }

  private async uploadPhoto(
    photo: Blob,
    record: PrintingRecord,
  ): Promise<UploadedPhoto> {
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(photo.type) ||
      !photo.size ||
      photo.size > MAX_COMPRESSED_IMAGE_BYTES
    )
      throw new GitHubError(
        "Compress the image first. Supported photos are JPEG, PNG and WebP up to 1.5 MB.",
        0,
        "validation",
      );
    const extension =
      photo.type === "image/png"
        ? "png"
        : photo.type === "image/webp"
          ? "webp"
          : "jpg";
    const now = new Date().toISOString();
    const path = `images/${now.slice(0, 4)}/${now.slice(5, 7)}/${now.replace(/:/g, "-")}_${crypto.randomUUID()}.${extension}`;
    const bytes = new Uint8Array(await photo.arrayBuffer());
    this.ensureActive();
    const result = await this.request<CommitResult>(
      `/contents/${pathURL(path)}`,
      "PUT",
      {
        message: `Add reference photo for printing record ${record.id}`,
        content: bytesToBase64(bytes),
        branch: this.config.branch,
      },
    );
    if (!isSha(result.commit?.sha) || !isSha(result.content?.sha))
      throw new GitHubError(
        "GitHub did not confirm the photo commit. An unused image may remain under images/. Refresh before retrying.",
        0,
        "uncertain",
      );
    return { path, sha: result.content!.sha, newlyUploaded: true };
  }

  private async removeFile(
    path: string,
    sha: string,
    message: string,
  ): Promise<void> {
    const result = await this.request<CommitResult>(
      `/contents/${pathURL(path)}`,
      "DELETE",
      { message, sha, branch: this.config.branch },
    );
    if (!isSha(result.commit?.sha))
      throw new GitHubError(
        "GitHub did not confirm the deletion. Refresh before retrying.",
        0,
        "uncertain",
      );
  }

  private async cleanupPhoto(path: string, knownSha?: string): Promise<void> {
    if (!safePhotoPath(path)) {
      this.warnings.push(
        "An unsupported photo path was left untouched. Review it in GitHub.",
      );
      return;
    }
    try {
      const current = await this.loadRecords(true);
      if (
        current.issues.length ||
        current.records.some((stored) => stored.record.photo_path === path)
      ) {
        this.warnings.push(
          "An old image was kept because it may still be referenced. Review unused files under images/ when convenient.",
        );
        return;
      }
      const metadata = await this.content(path);
      if (knownSha && knownSha !== metadata.sha) {
        this.warnings.push(
          "An image changed during cleanup and was left untouched. Review it in GitHub.",
        );
        return;
      }
      await this.removeFile(
        path,
        metadata.sha,
        "Remove unused printing reference photo",
      );
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return;
      this.warnings.push(
        "Image cleanup could not be confirmed. An unused image may remain under images/; record data was left untouched by cleanup.",
      );
    }
  }

  private async afterPhotoFailure(
    error: unknown,
    photo?: UploadedPhoto,
  ): Promise<never> {
    if (
      photo &&
      error instanceof GitHubError &&
      error.kind !== "uncertain" &&
      error.kind !== "disconnected" &&
      error.status < 500
    )
      await this.cleanupPhoto(photo.path, photo.sha);
    if (
      photo &&
      error instanceof GitHubError &&
      (error.kind === "uncertain" || error.kind === "disconnected")
    )
      throw new GitHubError(
        `${error.message} The uploaded photo was kept to avoid breaking a possibly saved record.`,
        error.status,
        error.kind,
        error.retryAt,
      );
    throw error;
  }

  private queueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.writeQueue.then(async () => {
      this.ensureActive();
      this.warnings.length = 0;
      return operation();
    });
    this.writeQueue = queued.catch(() => undefined);
    return queued;
  }

  create(record: PrintingRecord, photo?: Blob): Promise<StoredRecord> {
    return this.queueWrite(async () => {
      const errors = validateRecord(record);
      if (errors.length)
        throw new GitHubError(errors.join(" "), 0, "validation");
      const path = recordPath(record);
      if (!isRecordPath(path))
        throw new GitHubError(
          "This record cannot be given a safe filename.",
          0,
          "validation",
        );
      const existing = await this.getRecordIfExists(path);
      if (existing) {
        const expected = { ...record, photo_path: existing.record.photo_path };
        if (sameRecord(existing.record, expected)) {
          if (photo) {
            if (!existing.record.photo_path)
              throw new GitHubError(
                "This record already exists without this photo. Refresh and edit the saved record instead.",
                409,
                "conflict",
              );
            const existingPhoto = await this.content(
              existing.record.photo_path,
            );
            if (existingPhoto.sha !== (await blobSha(photo)))
              throw new GitHubError(
                "This record already exists with a different photo. Refresh and edit it instead.",
                409,
                "conflict",
              );
          } else if (existing.record.photo_path)
            throw new GitHubError(
              "This record already exists with a photo. Refresh and edit it instead.",
              409,
              "conflict",
            );
          // A successful API read confirms the exact record is already committed on this branch.
          this.cache.set(path, existing);
          this.warnings.push(
            "GitHub confirmed this record was already saved. No duplicate was created.",
          );
          return existing;
        }
        throw new GitHubError(
          "A different record already occupies this filename. Refresh and review it before retrying.",
          409,
          "conflict",
        );
      }
      let uploaded: UploadedPhoto | undefined;
      try {
        if (photo) uploaded = await this.uploadPhoto(photo, record);
        return await this.writeRecord(path, {
          ...record,
          photo_path: uploaded?.path ?? null,
        });
      } catch (error) {
        return this.afterPhotoFailure(error, uploaded);
      }
    });
  }

  update(
    stored: StoredRecord,
    record: PrintingRecord,
    photoChange?: Blob | null,
  ): Promise<StoredRecord> {
    return this.queueWrite(async () => {
      if (!isRecordPath(stored.path) || !isSha(stored.sha))
        throw new GitHubError("Invalid record location.", 0, "validation");
      const next = {
        ...record,
        id: stored.record.id,
        created_at: stored.record.created_at,
        date_key: stored.record.date_key,
        is_legacy: stored.record.is_legacy,
        updated_at: new Date().toISOString(),
        photo_path: stored.record.photo_path,
      };
      const errors = validateRecord(next);
      if (errors.length)
        throw new GitHubError(errors.join(" "), 0, "validation");
      const current = await this.content(stored.path);
      if (current.sha !== stored.sha)
        throw new GitHubError(
          "This record was changed by someone else. Refresh and review the latest version before editing again. Your entered values have been kept.",
          409,
          "conflict",
        );
      let uploaded: UploadedPhoto | undefined;
      let saved: StoredRecord;
      try {
        if (photoChange) uploaded = await this.uploadPhoto(photoChange, next);
        next.photo_path =
          uploaded?.path ??
          (photoChange === null ? null : stored.record.photo_path);
        saved = await this.writeRecord(stored.path, next, current.sha);
      } catch (error) {
        return this.afterPhotoFailure(error, uploaded);
      }
      if (
        stored.record.photo_path &&
        next.photo_path !== stored.record.photo_path
      )
        await this.cleanupPhoto(stored.record.photo_path);
      return saved;
    });
  }

  delete(stored: StoredRecord): Promise<{ warnings: string[] }> {
    return this.queueWrite(async () => {
      if (!isRecordPath(stored.path) || !isSha(stored.sha))
        throw new GitHubError("Invalid record location.", 0, "validation");
      const current = await this.content(stored.path);
      if (current.sha !== stored.sha)
        throw new GitHubError(
          "This record changed since it was loaded. Refresh and review it before deleting.",
          409,
          "conflict",
        );
      await this.removeFile(
        stored.path,
        current.sha,
        `Delete printing record ${stored.record.id}`,
      );
      this.cache.delete(stored.path);
      if (stored.record.photo_path)
        await this.cleanupPhoto(stored.record.photo_path);
      return { warnings: [...this.warnings] };
    });
  }

  /**
   * Import a reviewed migration into a private repository. Stable paths and
   * exact byte comparisons make an interrupted import safe to resume, without
   * overwriting an edited historical record or claiming an unconfirmed write.
   */
  async importFiles(
    files: GitHubImportFile[],
    onProgress?: (done: number, total: number, skipped: number) => void,
  ): Promise<{ uploaded: number; skipped: number }> {
    if (!Array.isArray(files) || !files.length || files.length > 10_000)
      throw new GitHubError(
        "Choose a migration containing between 1 and 10,000 files.",
        0,
        "validation",
      );
    const seen = new Set<string>();
    let totalBytes = 0;
    // Copy before queuing: a caller cannot change a selected migration while
    // another write is finishing or an import is already in progress.
    const snapshot = files.map((file) => {
      if (
        !file ||
        typeof file.path !== "string" ||
        !/^(?:records\/\d{4}\/(?:0[1-9]|1[0-2])\/[A-Za-z0-9_-]+\.json|backups\/(?:legacy_data|migration-report)\.json)$/.test(
          file.path,
        ) ||
        seen.has(file.path) ||
        !(file.bytes instanceof Uint8Array) ||
        !file.bytes.byteLength ||
        file.bytes.byteLength > 10 * 1024 * 1024
      )
        throw new GitHubError(
          "Import refused: unsupported, duplicate or oversized migration file. Use the original JSON export to prepare it again.",
          0,
          "validation",
        );
      seen.add(file.path);
      totalBytes += file.bytes.byteLength;
      if (totalBytes > 25 * 1024 * 1024)
        throw new GitHubError(
          "This migration is larger than 25 MB. Split it into smaller reviewed imports.",
          0,
          "validation",
        );
      const bytes = new Uint8Array(file.bytes);
      let record: PrintingRecord | undefined;
      try {
        const value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        if (file.path.startsWith("records/")) record = parseRecord(value);
        else if (!value || typeof value !== "object") throw new Error();
      } catch {
        throw new GitHubError(
          "Import refused: a migration file is not valid JSON or contains an invalid record. Prepare the original export again and review its errors.",
          0,
          "validation",
        );
      }
      return { path: file.path, bytes, record };
    });

    return this.queueWrite(async () => {
      let uploaded = 0;
      let skipped = 0;
      let currentPath: string | undefined;
      try {
        const access = await this.verifyAccess();
        if (!access.private)
          throw new GitHubError(
            "Import refused: business records must go into a private data repository, never the public website repository.",
            0,
            "privacy",
          );
        // An inaccessible repository/branch must never be mistaken for a set
        // of missing files merely because the Contents API returns a 404.
        const head = await this.request<{
          sha: string;
          commit: { tree: { sha: string } };
        }>(`/commits/${encodeURIComponent(this.config.branch)}`);
        if (!isSha(head.sha) || !isSha(head.commit?.tree?.sha))
          throw new GitHubError(
            "Initialize the private data repository with a README on the selected branch before importing.",
            0,
            "uninitialized",
          );
        onProgress?.(0, snapshot.length, 0);
        for (const file of snapshot) {
          this.ensureActive();
          currentPath = file.path;
          let existing: ContentResult | undefined;
          try {
            existing = await this.content(file.path);
          } catch (error) {
            if (!(error instanceof GitHubError && error.status === 404))
              throw error;
          }
          if (existing) {
            if (existing.type !== "file")
              throw new GitHubError(
                `Import refused: ${file.path} is not a regular file. No overwrite was attempted.`,
                409,
                "conflict",
              );
            let currentBytes: Uint8Array;
            try {
              if (
                existing.encoding === "base64" &&
                typeof existing.content === "string"
              )
                currentBytes = decodeBase64(existing.content);
              else {
                // Contents responses omit inline data above 1 MB. Read the
                // immutable blob so even a larger original backup is compared.
                const blob = await this.request<{
                  content: string;
                  encoding: string;
                }>(`/git/blobs/${existing.sha}`);
                if (
                  blob.encoding !== "base64" ||
                  typeof blob.content !== "string"
                )
                  throw new GitHubError(
                    "GitHub did not return readable file contents.",
                    0,
                    "invalid_response",
                  );
                currentBytes = decodeBase64(blob.content);
              }
            } catch (error) {
              if (error instanceof GitHubError) throw error;
              throw new GitHubError(
                "GitHub returned an unreadable migration file. No overwrite was attempted.",
                0,
                "invalid_response",
              );
            }
            if (
              currentBytes.byteLength !== file.bytes.byteLength ||
              currentBytes.some((byte, index) => byte !== file.bytes[index])
            )
              throw new GitHubError(
                `A different or edited file already exists at ${file.path}. It was kept unchanged. Review it before retrying this import.`,
                409,
                "conflict",
              );
            if (file.record)
              this.cache.set(file.path, {
                record: file.record,
                path: file.path,
                sha: existing.sha,
              });
            skipped++;
          } else {
            const result = await this.request<CommitResult>(
              `/contents/${pathURL(file.path)}`,
              "PUT",
              {
                message: `Import historical printing file: ${file.path}`,
                content: bytesToBase64(file.bytes),
                branch: this.config.branch,
              },
            );
            if (!isSha(result.commit?.sha) || !isSha(result.content?.sha))
              throw new GitHubError(
                "GitHub did not confirm this import commit. The last file may already have reached the repository.",
                0,
                "uncertain",
              );
            if (file.record)
              this.cache.set(file.path, {
                record: file.record,
                path: file.path,
                sha: result.content!.sha,
              });
            uploaded++;
          }
          onProgress?.(uploaded + skipped, snapshot.length, skipped);
        }
        return { uploaded, skipped };
      } catch (error) {
        const cause =
          error instanceof GitHubError
            ? error
            : new GitHubError("The import was interrupted.", 0, "import");
        throw new GitHubError(
          `Import stopped after ${uploaded} confirmed new file${uploaded === 1 ? "" : "s"} and ${skipped} unchanged file${skipped === 1 ? "" : "s"}. ${cause.message} Select the same export and retry to resume; identical files will be skipped.`,
          cause.status,
          cause.kind,
          cause.retryAt,
          { uploaded, skipped, total: snapshot.length, path: currentPath },
        );
      }
    });
  }

  async loadPhoto(path: string): Promise<Blob> {
    if (!safePhotoPath(path))
      throw new GitHubError("This photo path is not allowed.", 0, "validation");
    const metadata = await this.content(path);
    const cached = this.photoCache.get(path);
    if (cached?.sha === metadata.sha) return cached.blob;
    const blob = await this.request<{ content: string; encoding: string }>(
      `/git/blobs/${metadata.sha}`,
    );
    if (blob.encoding !== "base64" || typeof blob.content !== "string")
      throw new GitHubError(
        "GitHub did not return the photo.",
        0,
        "invalid_response",
      );
    const bytes = decodeBase64(blob.content);
    if (bytes.length > MAX_COMPRESSED_IMAGE_BYTES)
      throw new GitHubError(
        "This photo is larger than the supported limit.",
        0,
        "validation",
      );
    const type = /\.png$/i.test(path)
      ? "image/png"
      : /\.webp$/i.test(path)
        ? "image/webp"
        : "image/jpeg";
    const photo = new Blob([new Uint8Array(bytes).buffer], { type });
    if (this.photoCache.size >= 20)
      this.photoCache.delete(this.photoCache.keys().next().value!);
    this.photoCache.set(path, { sha: metadata.sha, blob: photo });
    return photo;
  }
}
