import { useId, useState, type FormEvent } from "react";
import type { GitHubConfig } from "../types";
import { Icon } from "./Icon";
export type RepositoryPreferences = {
  owner: string;
  repo: string;
  branch: string;
};
export function ConnectionForm({
  preferences,
  onConnect,
}: {
  preferences: RepositoryPreferences;
  onConnect: (config: GitHubConfig, rememberDevice?: boolean) => Promise<void>;
}) {
  const rememberHintId = useId();
  const [owner, setOwner] = useState(preferences.owner),
    [repo, setRepo] = useState(preferences.repo),
    [branch, setBranch] = useState(preferences.branch),
    [token, setToken] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await onConnect(
        {
          owner: owner.trim(),
          repo: repo.trim(),
          branch: branch.trim(),
          token: token.trim(),
        },
        remember,
      );
      setToken("");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Connection failed. Please check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="connection-form">
      <div className="security-note">
        <Icon name="shield" size={24} />
        <div>
          <strong>Set up this phone for the family.</strong>
          <p>
            Select Keep this phone connected so your parents can just open the
            app and add or view records. No daily login is needed.
          </p>
        </div>
      </div>
      <div className="form-grid">
        <label className="field">
          Repository owner
          <input
            className="input"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            required
            autoComplete="off"
            placeholder="iamarjunc"
            disabled={busy}
          />
        </label>
        <label className="field">
          Data repository
          <input
            className="input"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            required
            autoComplete="off"
            placeholder="printingpress-data"
            disabled={busy}
          />
        </label>
        <p className="field-hint field-wide">
          Use the private printingpress-data repository here. The public
          printingpress repository hosts the website and has no customer
          records.
        </p>
        <label className="field field-wide">
          Branch
          <input
            className="input"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            required
            autoComplete="off"
            placeholder="main"
            disabled={busy}
          />
          <span className="field-hint">
            Initialize this branch with a README before connecting.
          </span>
        </label>
        <label className="field field-wide">
          Fine-grained personal access token
          <input
            className="input token-input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="github_pat_…"
            disabled={busy}
          />
          <span className="field-hint">
            Select only your data repository. Permissions: Contents → Read and
            write; Metadata → Read.
          </span>
        </label>
      </div>
      <label className="remember-device-option">
        <input
          type="checkbox"
          aria-label="Keep this phone connected"
          aria-describedby={rememberHintId}
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
          disabled={busy}
        />
        <span>
          <strong>Keep this phone connected</strong>
          <span id={rememberHintId}>
            Only on a trusted family phone. Access will be saved in this
            browser; anyone using this phone can open the records. Leave
            unchecked for this tab only.
          </span>
        </span>
      </label>
      {error && (
        <div role="alert" className="notice notice-error">
          {error}
        </div>
      )}
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? <span className="spinner" /> : <Icon name="shield" size={17} />}{" "}
        {busy ? "Checking GitHub…" : "Connect to GitHub"}
      </button>
      <p className="field-hint">
        Use a private data repository for confidential records. A public
        repository makes every record and photo publicly readable.{" "}
        <a
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noreferrer"
        >
          Create a fine-grained token <Icon name="external" size={12} />
        </a>
      </p>
      <details className="family-access-note">
        <summary>Setting up access for the family?</summary>
        <p>
          For individual fine-grained tokens, use a private repository owned by
          a free GitHub organization. Add family accounts as organization
          members with repository write access. Outside collaborators on another
          person’s repository cannot use this token flow. A personal repository
          works with its owner’s own token.
        </p>
      </details>
    </form>
  );
}
