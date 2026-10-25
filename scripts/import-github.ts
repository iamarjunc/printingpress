export interface MigrationUploadFile {
  path: string;
  bytes: Buffer;
}
export interface MigrationUploadOptions {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  files: MigrationUploadFile[];
  onCommit?: (path: string) => void;
}

/** Upload only to an initialized private repository, never overwriting different bytes. */
export async function uploadMigration(
  options: MigrationUploadOptions,
  transport: typeof fetch = fetch,
) {
  const { owner, repo, branch, token, files, onCommit } = options;
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo) ||
    !branch ||
    !token.trim()
  )
    throw new Error(
      "A valid owner, repository, branch and private data token are required.",
    );
  for (const file of files) {
    if (
      !/^(?:records\/\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.json|backups\/(?:legacy_data|migration-report)\.json)$/.test(
        file.path,
      )
    )
      throw new Error("Upload refused: invalid migration file path.");
  }
  const root = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  async function api(
    path: string,
    init: RequestInit = {},
    allow404 = false,
  ): Promise<any> {
    let response: Response;
    try {
      response = await transport(`${root}${path}`, {
        ...init,
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...init.headers,
        },
      });
    } catch {
      throw new Error(
        "Network interrupted. A write may have reached GitHub; rerun the same import to reconcile identical paths safely.",
      );
    }
    if (response.status === 404 && allow404) return null;
    if (!response.ok) {
      if (response.status === 409 || response.status === 422)
        throw new Error(
          "GitHub reported a write conflict. No overwrite was attempted; rerun after checking the private repository.",
        );
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 429
      )
        throw new Error(
          `GitHub access/rate-limit error (${response.status}). Check the token, selected repository permissions and rate-limit reset before retrying.`,
        );
      throw new Error(
        `GitHub request failed (${response.status}). The import is resumable; existing identical files will be skipped.`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new Error(
        "GitHub returned an unreadable response. A write may have committed; rerun the same import to reconcile before assuming success.",
      );
    }
  }
  const metadata = await api("");
  if (metadata.private !== true)
    throw new Error(
      "Upload refused: the data repository must be private. Business records must not be uploaded to the public frontend repository.",
    );
  const branchInfo = await api(`/branches/${encodeURIComponent(branch)}`);
  if (!branchInfo?.commit?.sha)
    throw new Error(
      "Initialize the private repository with a README and create the selected branch before importing.",
    );
  let uploaded = 0;
  let skipped = 0;
  for (const { path, bytes } of files) {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const current = await api(
      `/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
      {},
      true,
    );
    if (current) {
      if (
        current.type !== "file" ||
        typeof current.content !== "string" ||
        !Buffer.from(current.content.replace(/\s/g, ""), "base64").equals(bytes)
      )
        throw new Error(
          `Refusing to overwrite different existing content at ${path}. Investigate before retrying.`,
        );
      skipped++;
      continue;
    }
    const confirmed = await api(`/contents/${encodedPath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Import legacy printing record: ${path}`,
        content: bytes.toString("base64"),
        branch,
      }),
    });
    if (!confirmed.commit?.sha || !confirmed.content?.sha)
      throw new Error(
        `GitHub did not confirm the commit for ${path}. Rerun the same import to reconcile before assuming success.`,
      );
    uploaded++;
    onCommit?.(path);
  }
  return { uploaded, skipped };
}
