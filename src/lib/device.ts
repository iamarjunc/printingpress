import type { GitHubConfig } from "../types";

const DB_NAME = "pressbook-trusted-device-v1";
const STORE_NAME = "access";
const RECORD_KEY = "github";
const CONTEXT = new TextEncoder().encode(
  "Pressbook trusted device connection v1",
);
const MAX_CIPHERTEXT_BYTES = 16_384;

export const DEVICE_CHANNEL = "pressbook-device-access";
export const DEVICE_SESSION_ID =
  globalThis.crypto?.randomUUID?.() ??
  `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export class DeviceStorageError extends Error {
  readonly code: "unavailable" | "invalid" | "storage" | "aborted";

  constructor(
    message: string,
    code: "unavailable" | "invalid" | "storage" | "aborted" = "storage",
  ) {
    super(message);
    this.name = "DeviceStorageError";
    this.code = code;
  }
}

interface SavedAccess {
  version: 1;
  key: CryptoKey;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

function canceled(): DeviceStorageError {
  return new DeviceStorageError("Saving this phone was canceled.", "aborted");
}

function checkActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw canceled();
}

function unreadable(): DeviceStorageError {
  return new DeviceStorageError(
    "The saved connection could not be opened. Ask the person who set up this phone to set it up again.",
    "invalid",
  );
}

function requireBrowserStorage(): void {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle)
    throw new DeviceStorageError(
      "This browser cannot remember this phone. Use a normal browsing window with site storage enabled.",
      "unavailable",
    );
}

function parseConfig(value: unknown): GitHubConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unreadable();
  const config = value as Record<string, unknown>;
  const { owner, repo, branch, token } = config;
  if (
    typeof owner !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) ||
    typeof repo !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) ||
    repo === "." ||
    repo === ".." ||
    typeof branch !== "string" ||
    !branch ||
    branch.length > 255 ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.split("/").some((part) => !part || part.startsWith(".")) ||
    typeof token !== "string" ||
    !token ||
    token.length > 4096 ||
    /\s/.test(token)
  )
    throw unreadable();
  return { owner, repo, branch, token };
}

function parseEnvelope(value: unknown): SavedAccess {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unreadable();
  const envelope = value as Partial<SavedAccess>;
  if (
    envelope.version !== 1 ||
    typeof CryptoKey === "undefined" ||
    !(envelope.key instanceof CryptoKey) ||
    envelope.key.type !== "secret" ||
    envelope.key.extractable ||
    envelope.key.algorithm.name !== "AES-GCM" ||
    (envelope.key.algorithm as AesKeyAlgorithm).length !== 256 ||
    !envelope.key.usages.includes("decrypt") ||
    !(envelope.iv instanceof ArrayBuffer) ||
    envelope.iv.byteLength !== 12 ||
    !(envelope.ciphertext instanceof ArrayBuffer) ||
    envelope.ciphertext.byteLength < 16 ||
    envelope.ciphertext.byteLength > MAX_CIPHERTEXT_BYTES
  )
    throw unreadable();
  return envelope as SavedAccess;
}

function openDatabase(signal?: AbortSignal): Promise<IDBDatabase> {
  requireBrowserStorage();
  checkActive(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;
    const timer = setTimeout(() => fail(), 15_000);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error?: DeviceStorageError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        error ??
          new DeviceStorageError(
            "This phone could not open its saved connection. Check that site storage is allowed and try again.",
          ),
      );
    };
    const onAbort = () => fail(canceled());
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      fail();
      return;
    }
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort();
        return;
      }
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME);
    };
    request.onerror = () => fail();
    request.onblocked = () => fail();
    request.onsuccess = () => {
      const db = request.result;
      if (settled || signal?.aborted) {
        db.close();
        if (!settled) fail(canceled());
        return;
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        fail(unreadable());
        return;
      }
      db.onversionchange = () => db.close();
      settled = true;
      cleanup();
      resolve(db);
    };
  });
}

function transaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
  signal?: AbortSignal,
): Promise<T> {
  checkActive(signal);
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    let result: T;
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        signal?.aborted
          ? canceled()
          : new DeviceStorageError(
              "This phone could not update its saved connection. Check that site storage is allowed and try again.",
            ),
      );
    };
    const onAbort = () => {
      try {
        tx.abort();
      } catch {
        // A transaction that has already committed cannot be canceled.
        // Its completion event still determines the actual outcome.
      }
    };
    try {
      tx = db.transaction(STORE_NAME, mode);
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      tx.onerror = fail;
      tx.onabort = fail;
      signal?.addEventListener("abort", onAbort, { once: true });
      const request = operation(tx.objectStore(STORE_NAME));
      request.onsuccess = () => {
        result = request.result;
      };
      // AbortSignal may have changed between the initial check and listener setup.
      if (signal?.aborted) onAbort();
    } catch {
      if (tx!) {
        try {
          tx.abort();
        } catch {
          /* The transaction may already have ended. */
        }
      }
      fail();
    }
  });
}

function matchesEnvelope(value: unknown, expected: SavedAccess): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SavedAccess>;
  const equal = (left: unknown, right: ArrayBuffer) =>
    left instanceof ArrayBuffer &&
    left.byteLength === right.byteLength &&
    new Uint8Array(left).every(
      (byte, index) => byte === new Uint8Array(right)[index],
    );
  return (
    candidate.version === 1 &&
    equal(candidate.iv, expected.iv) &&
    equal(candidate.ciphertext, expected.ciphertext)
  );
}

function notify(type: "saved" | "forgotten"): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(DEVICE_CHANNEL);
    try {
      channel.postMessage({ type, sender: DEVICE_SESSION_ID });
    } finally {
      channel.close();
    }
  } catch {
    // A notification failure does not undo a confirmed storage transaction.
  }
}

/**
 * Remember a connection only after an explicit trusted-phone opt-in.
 * The key lives on this device too: same-origin scripts can use it. This is
 * device-trust convenience, not protection against a compromised browser.
 */
export async function saveDevice(
  config: GitHubConfig,
  signal?: AbortSignal,
): Promise<void> {
  requireBrowserStorage();
  checkActive(signal);
  const validated = parseConfig(config);
  let envelope: SavedAccess;
  try {
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    checkActive(signal);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: CONTEXT, tagLength: 128 },
      key,
      new TextEncoder().encode(JSON.stringify(validated)),
    );
    checkActive(signal);
    envelope = { version: 1, key, iv: iv.buffer, ciphertext };
  } catch (error) {
    if (error instanceof DeviceStorageError) throw error;
    throw new DeviceStorageError(
      "This phone could not prepare a saved connection. Uncheck Keep this phone connected to use this tab only.",
    );
  }
  // Crypto must finish before the IndexedDB transaction starts; awaiting crypto
  // inside a live IDB transaction can let the browser close it automatically.
  const db = await openDatabase(signal);
  try {
    await transaction(
      db,
      "readwrite",
      (store) => store.put(envelope, RECORD_KEY),
      signal,
    );
    if (signal?.aborted) {
      // The abort may arrive just after IDB has committed. Remove only this
      // save, preserving any newer connection saved by another tab.
      let removed = false;
      await transaction(db, "readwrite", (store) => {
        const request = store.get(RECORD_KEY);
        request.addEventListener("success", () => {
          if (matchesEnvelope(request.result, envelope)) {
            store.delete(RECORD_KEY);
            removed = true;
          }
        });
        return request;
      });
      if (removed) notify("forgotten");
      throw canceled();
    }
  } finally {
    db.close();
  }
  notify("saved");
}

/** Return only decrypted configuration; never infer GitHub access from storage. */
export async function loadDevice(): Promise<GitHubConfig | null> {
  const db = await openDatabase();
  let value: unknown;
  try {
    value = await transaction(db, "readonly", (store) => store.get(RECORD_KEY));
  } finally {
    db.close();
  }
  if (value === undefined) return null;
  const envelope = parseEnvelope(value);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: envelope.iv,
        additionalData: CONTEXT,
        tagLength: 128,
      },
      envelope.key,
      envelope.ciphertext,
    );
    return parseConfig(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
    );
  } catch (error) {
    if (error instanceof DeviceStorageError) throw error;
    throw unreadable();
  }
}

/** Delete both the saved key and ciphertext; other open tabs should clear memory. */
export async function forgetDevice(): Promise<void> {
  const db = await openDatabase();
  try {
    await transaction(db, "readwrite", (store) => store.delete(RECORD_KEY));
  } finally {
    db.close();
  }
  notify("forgotten");
}
