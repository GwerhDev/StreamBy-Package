# Changelog

## 0.35.0

### Added

- **API tokens**, so agents and services can work with StreamBy as a user without the user's
  browser session. The README has the details.
  - `GET`, `POST` and `DELETE /user/api-tokens` let a user list, make and revoke their own
    tokens. These routes need a session: a token can't manage tokens.
  - A token is `sbt_` followed by 32 random bytes. It's shown once, when it's made.
  - **Scope:** each token is `read` (only reads) or `write` (reads and writes). It reaches a
    list of projects, or `'*'` for every project its owner is a member of, including ones they
    join later. It expires in 7, 30, 90 or 365 days, or never.
  - A request made with a token reaches only its scope:
    - a `read` token can't write;
    - a project outside its scope answers 404, and the project list and jobs show only its
      projects;
    - outside a project, it can only make a few reads.

    The owner's role in each project still applies on top, so a token never does more than
    its owner can, and it stops reaching a project once its owner leaves it.
  - **`resolveApiToken`** (exported, with `API_TOKEN_PREFIX`) is for the host's
    `authProvider`. It turns `Authorization: Bearer sbt_...` into the token's owner and scope,
    or `null` once the token is revoked or expired. The `authProvider` returns the scope as
    `Auth.apiToken`. Without it, a token would have all of its owner's access.
  - **New table: `api_tokens`.** It's created at startup in the main database, and it keeps
    only each token's SHA-256 hash, never the token itself.

### Security

- A connection authenticated with an API token can't open the WebSocket. It's closed with
  code 1008. The WebSocket belongs to the browser session and receives every event of its
  user, from any project.

## 0.34.0

### ⚠️ Migration and deploy

Read this before deploying 0.34.0.

- **Stored credentials are converted at startup.** The first time 0.34.0 starts, every stored
  credential is re-encrypted in the new format (`v2`, AES-256-GCM). This covers project API,
  database and storage connections, export credentials, and user integrations. Distribution and
  render farm credentials, which were stored unencrypted, are encrypted. The conversion is
  non-destructive: a value is only replaced by its own re-encryption, and one that can't be
  decrypted with the configured keys is left as it is and logged.
- **There's no going back after the conversion.** Versions before 0.34.0 can't read the `v2`
  format. Once 0.34.0 has started against your databases, don't roll back to 0.33.x. If you run
  several instances, deploy all of them together, so that no older instance reads converted
  credentials.
- **Don't rotate the encryption key in the same deploy that does the conversion.** The old
  format (AES-256-CBC) doesn't record which key encrypted a value. Deploy 0.34.0 with your
  current key first. Rotate afterwards, with the new `encryptPreviousKeys` option (see the
  README).

### Breaking changes

- **Permissions depend on the member's role in the project**, not on the platform role that
  `authProvider` returns (`Auth.role`). Only active members count (`status: 'active'`); a
  pending invitation gives no access.
- **Editing a project requires being an editor or an admin of it.** This covers its content,
  connections, exports, files, jobs, workflow, pipelines, production, reviews and rights, and
  the upload URLs.
- **Deleting a project and managing its members requires being an admin of it.** A platform
  admin who isn't an admin of the project can't do either.
- **The public export route doesn't run nodes that use credentials, nor nodes that start
  jobs.** A request to `GET /:projectId/export/:exportName` has no session, so only nodes that
  read data run: static JSON, the built-in databases and storage, and the project's own
  connections. A node using an account integration (Claude, Jira, Google, or a user's own
  database or storage), or one that starts a job (transcode, render, AI and the like), fails
  with an error.
- **`getDecryptedIntegrationCredentialById` now takes the project** as its third argument:
  `getDecryptedIntegrationCredentialById(integrationId, config, project)`. It resolves the
  credential only while the integration's owner is an active member of that project.
- **`GET /users/search` requires a session.**

### Security

- An account integration's credential is tied to its owner. It resolves only for a project its
  owner is an active member of.
- An integration node sends its credential only to its own provider's API: `api.anthropic.com`
  for Claude, `api.atlassian.com` or `*.atlassian.net` for Jira, and `*.googleapis.com` for
  Google. It does so over https, never to a URL with a port or credentials in it, and without
  following redirects.
- Only the public export route goes without a session. Before, any path containing `/export/`
  skipped authentication.
- A job is visible only to whoever started it, or to a member of its project.
- Stored credentials are encrypted with AES-256-GCM (authenticated, so an altered value fails
  to decrypt), and each value records the id of the key that encrypted it, so keys can be
  rotated.
- Distribution and render farm connections encrypt their credential when they're saved.

### Added

- `encryptPreviousKeys` (in the router config): keys stored credentials may still be encrypted
  with. They're used only to decrypt, and what they hold is re-encrypted with `encrypt` at
  startup.
- Distribution and render farm connections take their credential as `credential`. The old name,
  `encryptedCredential`, is still accepted for the same plain value.
