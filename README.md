# Pressbook

A small, mobile-friendly printing press record book built with React, Vite, TypeScript and Tailwind CSS. The frontend runs for free on GitHub Pages. Each order is a separate JSON file in a private GitHub repository; reference images are separate files. There is no application backend or paid service; GitHub remains the permanent record store.

## Architecture and important limits

```text
Public frontend repository                  Private records repository
  src/                                       records/YYYY/MM/*.json
  public/                                    images/YYYY/MM/*
  scripts/import-legacy.ts                    backups/legacy_data.json
  .github/workflows/pages.yml
       │                                            ▲
       └── GitHub Pages → authorized browser ────────┘
                          GitHub REST API over HTTPS
```

GitHub Pages serves static files and cannot keep a secret in its public build. A family member provisions this device with an authorized fine-grained personal access token for the selected private data repository. Credentials never belong in source, URLs, build variables or Git history. The app sends the token only in an Authorization header to `api.github.com`.

The connection has two explicit modes:

- **Trusted family phone:** during device setup, select **Keep this phone connected**. This is unchecked by default. After GitHub verifies the connection and the browser successfully saves it, the complete connection configuration and token are encrypted with AES-256-GCM in IndexedDB. The non-extractable encryption key is also held on the same device. Reopening the website restores the connection, verifies the token with GitHub, and loads the latest records. Parents do not enter a password, PIN, or GitHub token each day.
- **Temporary connection:** leave **Keep this phone connected** unchecked. The token stays in memory for the current page session. Refreshing or closing the page ends that connection; device setup is needed again.

The saved-device option is a convenience for a **trusted, screen-locked phone**, not an app password or a separate authentication system. Because the key is on the same device, encryption does not prevent a script running on the website, a malicious browser extension, malware, or someone using an unlocked phone from using the saved credential. Non-extractable means the browser does not expose raw key bytes; it does not stop code on the same origin from asking the browser to decrypt. GitHub Pages project sites under the same `username.github.io` domain share an origin; other applications published on that origin are included in this trust boundary. Do not enable this option on a public or untrusted shared device. Record files themselves are not persisted in IndexedDB; they remain in the private GitHub repository and are held in memory while open.

Use **Device setup → Forget this phone** to remove its saved credential and clear its active connection. Other open Pressbook tabs in the same browser receive a forget notification through BroadcastChannel and clear their connections too. Forgetting this phone does not delete GitHub records and does not revoke the token on other devices. Revoke a lost or compromised token through GitHub. An expired or revoked token requires a family member to reconnect this phone; the app does not bypass GitHub authorization or pretend an offline save succeeded.

Use a narrowly scoped token, choose an expiry, and keep the device screen locked. Prefer a separate token per provisioned device so a lost phone can be revoked independently. The token's GitHub account supplies the real permissions and GitHub audit identity. People using the same provisioned phone are not separate authenticated GitHub identities: `added_by` is a manual diary label, not an identity check or permission boundary. Never paste a token into chat, email, or the public repository.

Use a **public frontend repository and a separate private data repository** for confidential records. An administrator can provision authorized owner-token access on trusted phones. For separate per-person GitHub accounts and fine-grained tokens, put the private data repository under a free GitHub organization. GitHub Pages on GitHub Free is intended for public source repositories; private data is fetched by the authenticated browser and is never included in the Pages build. Making the frontend public must not expose private records, photographs, exports or legacy backups. The included `.gitignore` excludes `.private-data/` and `.env*`; never force-add those files or put them in `public/`.

**Fine-grained token membership limitation:** GitHub currently does not support fine-grained tokens for contributing to a repository where the token holder is an outside or repository collaborator. Inviting a family member only as a collaborator to another person’s private repository is therefore insufficient. For shared family access, create a **free GitHub organization**, invite family members as **organization members**, grant them write access to the private data repository, and have each member select that organization as the token’s resource owner. An organization owner may need to approve the token. A personal repository can use its owner’s own authorized fine-grained token. If you want each family member to have a distinct GitHub identity and token, the free organization approach supports that without adding a backend or paid service. Provisioning a trusted phone once does not create a separate GitHub identity for each person using it. See GitHub’s [fine-grained personal access token limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations) and [token creation instructions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token).

The authenticated GitHub REST API supports the browser requests used here. No OAuth client secret or proxy server is needed. If an organization disallows fine-grained tokens, it must approve a permitted token or change the policy. Do not bypass the policy by publishing data or embedding a shared token. A secure free alternative for restricted organizations is a trusted local import/export client using their approved Git credentials; this does not provide browser editing until the policy permits it.

GitHub is suitable for a modest family record book. It is not a high-volume transactional database. Each create/edit/delete generates a commit, rate limits apply, and very large collections/images grow the repository. Keep photos compact and retain periodic backups. GitHub Actions is triggered only by frontend changes, so daily order entry does not require a Pages rebuild.

## Local development

Requires Node.js 24 and npm. No credentials are needed to build or run the interface.

```bash
npm ci
npm run dev
```

Open the development server address printed by Vite. To connect real records, open the small gear button for **Device setup** and enter the private data repository's owner, repository, branch and authorized token. Select **Keep this phone connected** only on a trusted device if you want automatic reconnection. The private repository must already have an initialized branch (create it with a README).

```bash
npm test             # Domain, GitHub API and migration regression tests
npm run build        # TypeScript checks and production bundle
npm run preview      # Serve the production bundle locally
npm run test:e2e     # Browser tests; see testing notes below
```

For a machine without Chromium installed, install Playwright's Chromium with `npx playwright install chromium` before browser tests. The cloud environment includes a system Chromium. The browser-test configuration documents the executable selection.

## Free deployment, step by step

1. **Create the frontend repository.** On GitHub create a public repository, for example `printingpress`. Put this source code, `package.json`, lockfile and workflow in it. Keep the default deployment branch named `main`. Do not add the `.private-data` directory or a token.
2. **Create the organization and data repository.** Create a free GitHub organization for the family press, then create a **private** repository inside it, for example `printingpress-data`, and initialize it with a README. GitHub Free organizations support private repositories; no paid plan is needed for this workflow. Its `main` branch must exist before API writes. The application creates `records/` and `images/` as needed. Do not enable Pages for this repository. A private personal repository provisioned with that owner’s authorized token is also supported; GitHub actions are then attributed to the token owner.
3. **Choose the authorized GitHub accounts.** For separate per-person tokens, invite those GitHub accounts through the organization’s **People** settings as **organization members**; they must accept. Grant them write access to the private data repository directly or through a team. Do not use outside-collaborator-only invitations: fine-grained tokens cannot currently contribute in that role. The family member doing setup provisions an authorized token once on each trusted phone. Parents using a provisioned phone do not need to repeat GitHub login or token entry. A public frontend does not grant access to private records.
4. **Create a fine-grained token for device setup.** The authorized token holder opens **GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**. Select the **family organization** as resource owner (or your own account for your personal repository), choose **Only select repositories**, select only the private data repository, set an expiry, and grant **Repository permissions → Contents: Read and write**. Metadata read access is included automatically. No Actions, Administration or Pages write permission is required for daily use. An organization owner may need to approve the token before it can access private records. If the organization is missing from the resource-owner list, check that the person accepted membership and that organization policy permits fine-grained tokens.
5. **Enable GitHub Pages.** In the public frontend repository open **Settings → Pages**, choose **GitHub Actions** as the source. Push the frontend to `main` or run **Actions → Deploy Pressbook to GitHub Pages → Run workflow**. The workflow installs with `npm ci`, runs unit tests, builds, and publishes only `dist/`. Relative Vite asset paths support both `username.github.io/project/` and a custom domain.
6. **Set up each trusted phone once.** Open the published Pages address shown by GitHub's deployment. Open the gear button → **Device setup**, enter data owner/repository/branch and the authorized token, select **Keep this phone connected**, then connect. Wait for the verified connection and saved-device confirmation. Close and reopen the website to check that records reload automatically. Leave the checkbox unchecked for a temporary connection. Never enter the token into a URL or a `VITE_*` environment variable. Device setup is a maintenance area, not a separate administrator login.
7. **Import the existing diary.** Follow the next section from a trusted local machine. This is a one-time operation; reruns are safe. After import, use **Refresh** in the app. No website rebuild is required.
8. **Test a new record.** Create a clearly labelled temporary order with positive whole numbers. Check the app confirms GitHub's commit and the private repository contains one JSON file. Reopen it, verify values and timestamps, and use customer history.
9. **Test edit and delete.** Edit the temporary order and verify the same file changed, `created_at` stayed unchanged and `updated_at` was set. In a second browser/device, try editing the old version: it must report a conflict rather than silently overwrite. Refresh and review before retrying. Delete the temporary record using the confirmation dialog and check its file is gone.
10. **Test a photo.** Create another temporary record with a JPEG, PNG or WebP image. Check the preview, saved image, details view, replace and remove actions. Confirm images are separate files under `images/`, not Base64 in JSON. Delete the test record afterward. If cleanup is interrupted, follow the explicit orphan warning rather than assuming every file was removed.
11. **Use on phones.** Open the same Pages URL in Safari or Chrome on the provisioned phone and optionally add it to the home screen. Parents can open the app, tap **Add record**, enter the order, and wait for **Record saved**. **All records** and **Customers** find earlier work. There is no daily password or GitHub login in trusted-phone mode. This is a responsive website, not an offline app. Keep the phone screen locked; use **Forget this phone** before giving it to an untrusted person.
12. **Update later.** Change frontend source, run the checks above, commit and push to `main`. GitHub Actions redeploys the UI; the separate data repository and existing order files stay unchanged. An expired token can be replaced without rebuilding the site.

The workflow requires repository Pages deployment to be enabled. It intentionally has no data-repository secret and never downloads private business data during build.

## Import the actual legacy data

The supplied `legacy_data.json` has already been inspected and migrated locally into the ignored `.private-data/` directory. It contains 14 valid historical rows. All 14 were retained, including suspicious duplicates; no original creation timestamp, customer spelling, ID or `is_legacy` flag was rewritten. The backup is an exact byte-for-byte copy. The migration report identifies quantity inconsistencies, customer capitalization variants and possible duplicate ranges for review. These warnings are not proof that a historical entry is wrong.

Private files prepared locally:

```text
.private-data/
  backups/legacy_data.json      # Exact original export
  records/YYYY/MM/*.json        # One independent JSON file per historical row
  migration-report.json         # Counts, source SHA-256 and review warnings
```

The actual business data is deliberately **not bundled with the public website or frontend source**. Keep `.private-data/` or the separate private migration bundle on a trusted machine. The app will show these existing records after they have been uploaded to the configured private data repository and refreshed.

To reproduce preparation with the original export:

```bash
npm ci
npm run import:legacy -- --input /safe/path/legacy_data.json
```

Paths use the original creation month and a UTC timestamp plus a deterministic hash. Content preserves the source timestamps, including fractional-second precision and timezone. Missing optional `updated_at` and `photo_path` are set to `null`. IDs are kept; absent IDs receive deterministic IDs. Repeated identical historical rows are retained separately using a stable occurrence suffix. The same export always creates the same files. Running the same import twice verifies identical bytes and creates no duplicates. A changed existing destination file causes a refusal, never an overwrite. Invalid records are listed in the report and remain in the original backup; valid rows are prepared, but upload waits until rejected rows are resolved.

To upload, initialize the private repository and create a token with Contents read/write as described above. In Bash, enter it without echoing it or putting it in shell history:

```bash
read -rsp 'Private data token: ' PRIVATE_DATA_TOKEN
printf '\n'
export PRIVATE_DATA_TOKEN
npm run import:legacy -- --input /safe/path/legacy_data.json --upload --owner YOUR_ORG_NAME --repo printingpress-data --branch main
unset PRIVATE_DATA_TOKEN
```

`PRIVATE_DATA_TOKEN` is a **local script-only** process variable; it is never a frontend build variable. The importer checks that the destination is private, refuses public-repository uploads, commits each record through GitHub's Contents API, and stores the original backup and review report under `backups/`. A commit counts as successful only after GitHub returns its commit and file SHA. Existing byte-identical files are skipped. On a network interruption, rerun the same command: a request may have reached GitHub even if the response did not return, so the importer reconciles the stable paths before writing again. Concurrent changes or mismatching files cause a refusal for manual review.

An alternative without a script token is to copy only the prepared `records/` and `backups/` into a local clone of the **private data repository**, inspect `git status`, commit and push using your approved Git credentials. Never copy them to the public frontend repository. Keep `migration-report.json` with the private backup.

## Everyday workflow

The normal navigation contains four actions: **Home**, **Add record**, **All records**, and **Customers**. GitHub connection fields, token settings, and backups are kept in **Device setup**, reached through the small gear button or the sidebar footer. Hiding setup from the daily menu is a usability choice, not a security boundary.

For the parents after one-time trusted-phone setup:

1. Open Pressbook and let it reconnect and load records.
2. Tap **Add record**, enter the order, and choose the correct person under **Added by**.
3. Tap **Save record** and wait for **Record saved** before closing the page.
4. Use **All records** to search, or **Customers** to check previous ranges.

Additional controls:

- **Home:** totals, recent orders and a simple ready/offline state. Customer totals group case/spacing variants while preserving original names.
- **Add record:** customer and bill-type suggestions, the exact family dropdown, chosen creation date with automatic local time, and optional photo preview. Numbers must be positive whole numbers; end must not precede start.
- **History:** inspect the selected customer's previous number ranges before entering a new order. A next-number suggestion needs an explicit user action. Duplicate, overlap and quantity warnings do not rewrite or block legitimate reprints.
- **All records:** search names, bill types and serial numbers; filter by date/person; sort and page through loaded results; open details, edit, or delete with confirmation.
- **Refresh:** retrieve the latest committed state. Current-session data is cached by file SHA, so unchanged JSON is not downloaded repeatedly.
- **Device setup:** a family member manages the storage connection and saved-device choice here. **Forget this phone** removes remembered access. **Backup & advanced options** contains JSON/CSV exports and technical privacy guidance.

Creation dates are displayed in the device's local timezone; UTC timestamps are stored unambiguously. Entering an older diary date uses that chosen local date and the current local clock time. Editing preserves the exact original `created_at`; only `updated_at` changes. Changing a historical timestamp requires a deliberate separate data correction, not an ordinary order edit.

The app does not calculate books from range/pages. Such a calculation is shown only as a review warning because duplicates, formats and copies may be legitimate. Malayalam text uses Unicode throughout; names can be entered normally with the device's Malayalam keyboard.

## Storage, conflicts and photos

Create writes a new uniquely named JSON file through the Contents API. Edit and delete compare the known file SHA with the latest GitHub version and send the current SHA; a conflict requires refresh and review. The app does not silently retry an overwrite. Git's commit history provides an audit trail in addition to `created_at`, `updated_at` and `added_by`.

Listing resolves a branch commit, reads the Git tree and caches records by path/blob SHA. If GitHub truncates a recursive tree, the service traverses subtrees instead of assuming omitted files do not exist. Malformed files produce visible warnings; they are never silently deleted or replaced. The UI paginates loaded records and preserves the previous committed view when a refresh fails. Very large repositories still require downloading each previously unseen record once; this is a documented scaling limit, not a hidden public index.

Photos accept JPEG, PNG and WebP input, limit the source to 12 MB, resize to a maximum dimension of 1600 pixels and compress before upload. The app enforces the final output size limit too. Camera/gallery behavior depends on the mobile browser. HEIC must be converted by the device first. An image is committed before the JSON reference; if record creation definitively fails, cleanup is attempted. If a write outcome is uncertain, the file is retained for reconciliation rather than deleting a potentially referenced photo. Existing photos are removed only after the record edit/delete is confirmed. Cleanup failures are reported as warnings and may leave an orphan image; they do not mean a confirmed order save failed. Review referenced paths before manually deleting an orphan.

## Offline behavior, rate limits and recovery

GitHub is permanent record storage. IndexedDB is used only for the explicitly opted-in saved-device credential; it is not a local record database or an offline save queue. The app shows an offline state, and failed saves retain entered form values. It warns before leaving an unsaved form. Loaded record data remains in memory. A browser crash, forced refresh or device shutdown can lose unsaved input even when the phone's connection is remembered; keep the page open until **Record saved** appears. On reopening, trusted-phone mode restores the credential, verifies it with GitHub, and reloads committed records. A disconnected, offline, expired or revoked connection cannot save records.

Authentication errors, rate limits, network failures and conflicts have separate messages. Wait for GitHub's reset/retry time when supplied. A network failure after sending a write can have an uncertain outcome: refresh and inspect the stable record before retrying, rather than creating another order. Do not issue repeated unchanged requests against a rate limit.

Fine-grained tokens can be restricted by organization policy, pending approval, expiration, repository selection or repository permissions. Outside/repository collaborators cannot currently use fine-grained tokens to contribute; family members should be organization members with write access to the organization-owned data repository. A 404 may mean the private repository/branch is unavailable to the current token; it does not prove the repository does not exist. A family member can correct the owner, repository, branch or token in **Device setup**, then reconnect the phone. Token permissions need not be broadened beyond the data repository's Contents permission.

## Export, backup and restore

Open **Device setup → Backup & advanced options** to export records. JSON export contains the loaded `PrintingRecord[]` and is suitable for data interchange. CSV contains readable columns for spreadsheets, with spreadsheet-formula protection. Exports can contain confidential customer details; save them somewhere private. Exports are a snapshot of the current successful load, so refresh first. JSON/CSV exports include photo paths, **not image binaries or Git history**.

For a complete backup, clone/mirror the **private data repository** to a trusted machine or download its archive while authenticated. A Git mirror retains commit history and deleted versions:

```bash
git clone --mirror https://github.com/YOUR_ORG_NAME/printingpress-data.git printingpress-data-backup.git
```

Use Git's approved credential manager/platform authentication; never put a token in the URL. Keep the backup outside the public frontend checkout. Protect the backup as confidential business data.

To restore an unchanged repository archive, copy its `records/`, `images/` and `backups/` into a clean clone of a new initialized private repository, review the files, commit and push. Then connect the app to that repository and refresh. To restore a Git mirror including history, use Git's documented mirror push only to a new empty private repository: mirror pushes can overwrite/delete destination refs and must never target the public frontend or a repository containing newer work.

For record-only recovery from a JSON export, first prepare it with the importer into a new output folder:

```bash
npm run import:legacy -- --input /safe/path/pressbook-export.json --output /safe/path/restored-data
```

The importer preserves IDs, timestamps and existing `is_legacy` flags. It creates deterministic filenames for the recovery import; it does not guess the original file paths. **Upload a record-only restore into a new private repository**, or compare it manually with existing records before merging. Importing an export over an already populated data repository can produce two files with the same logical record if the original path was different. Restore photo files separately while preserving the JSON's `photo_path` values. CSV is a human-readable backup, not a lossless restore format.

GitHub's file history can restore an accidentally edited/deleted individual record: inspect the relevant commit in the private repository, recover the previous JSON, and commit the correction with an explanatory message. Always refresh other devices afterward.

## Testing

`npm test` runs deterministic domain, migration and mocked GitHub-API tests without a token. These verify validation, original timestamp preservation, idempotent migration, conflict/error paths, private data handling and confirmed commits. `npm run test:e2e` exercises the UI in desktop/mobile browser contexts with a mocked GitHub API, so it never mutates a real private repository. `npm run build` checks types and creates only frontend assets.

For release verification, perform deployment steps 8–10 against a dedicated private test repository using your own short-lived token. Mocked tests cannot prove a particular live token, organization policy, deployed CORS/network route or Pages configuration works. No live repository commit or production deployment should be claimed without those checks.

Project structure:

```text
src/
  components/              Reusable interface components
  lib/github.ts            Authenticated GitHub storage and errors
  lib/records.ts           Validation, search, date and history helpers
  lib/images.ts            Client-side reference photo compression
  types.ts                 Shared record/session types
scripts/
  import-legacy.ts         CLI local preparation/private GitHub upload
  import-lib.ts            Deterministic migration and review report
  import-github.ts         Private-only, resumable upload and commit checks
.github/workflows/pages.yml
```

No real token is required or permitted in test fixtures. Review dependency updates and third-party scripts carefully because this frontend handles GitHub credentials in the browser, including optional trusted-device credentials. Validate both temporary mode and opt-in remembered-device mode, reload/automatic reconnection, expired-token handling, and **Forget this phone** across open tabs before release.
