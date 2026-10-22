# Changelog

## 0.38.0

### Added

- **Uploading and downloading files from the MCP server**, so an agent can bring files from and
  to the tools it works with (Blender's or Godot's own MCP, a script). The file never goes
  through the conversation: the tools give signed URLs, and the tool that has the file uploads
  or downloads it directly. See the README for an example with Blender.
  - `request_asset_upload` (`assets:write`): a new asset, or a new version of one, and the URL
    to upload its file to.
  - `get_asset_download_url` (`assets:read`): a URL to download an asset's file, its latest
    version or an earlier one. `list_asset_versions` lists them.
- **Asset versions are kept, and an asset's URL doesn't change when it's replaced.** A new
  version (`replace-url`, from the UI too) is still uploaded to the asset's own key, so a site
  that links to the asset shows the new one. Before that, the current version is copied to a
  key of its own, `<key>.v<n>.<ext>`, and recorded in `asset_versions` (an asset's first
  version is recorded on upload; an older asset gets it when it's first replaced). If it can't
  be copied, nothing is replaced and no upload URL is given. The `replace-url` routes answer
  the new version's `versionId` and `version`. Deleting an asset deletes every key of it.
  - New `StorageAdapter.copyFile`, implemented by the S3 adapter. With an adapter without it,
    asking for a new version answers 501.
  - StreamBy doesn't set `Cache-Control` on uploads, so a browser or a CDN may serve a replaced
    asset's earlier version for a while: set it where the files are served (see the README).
- `GET /projects/:projectId/assets/:fileId/download-url` (`?versionId=` for an earlier version):
  a signed URL that downloads the file with its name, wherever it's stored.
- **Deliverables**: an asset, or one of its versions, delivered for a production shot or for an
  export, kept in the NoSQL database's `deliverables` collection. `GET`, `POST` and
  `DELETE /projects/:projectId/deliverables` list (by `shotId` or `exportId`), mark and remove
  them; `list_deliverables`, `mark_deliverable` and `remove_deliverable` in the MCP server.
  Deleting a shot, a sequence, an export or an asset removes its deliverables.
- **`mcp.signedUrlTtl`**: how long the signed URLs given to an API token work, also when it
  lists files. Default: 15 minutes to upload, 5 to download. A session's are as before.
- `StorageAdapter.getPresignedUploadUrl` and `getPresignedGetUrl` take how long the URL works
  (and `getPresignedGetUrl` the name to download it with).

### Fixed

- **Only editors and admins upload a new version of an asset.** The `replace-url` routes let
  any member of the project, a viewer included, replace an asset's file.
- The ingest job no longer records a second version of the file an upload already recorded.

## 0.37.0

### ⚠️ Breaking changes

- **API tokens have permissions, not an access level.** The tokens made before this version no
  longer work, and aren't listed: make new ones. There's no migration. The `api_tokens` table
  gets its new columns at startup (`kind`, `permissions`, `createdByName`), and its old
  `access` column becomes optional; nothing else is changed.
- **`ApiTokenScope` changed.** It has `kind` (`'user'` or `'project'`) and `permissions`,
  instead of `access`. `ApiTokenAccess` is gone.
- **`createApiToken`** takes who makes the token (`{ kind, userId, username, projectId }`), and
  `permissions` instead of `access`. `listApiTokens` and `revokeApiToken` are now
  `listUserApiTokens` and `revokeUserApiToken`.
- **The host's `authProvider` must handle a project's token** (see the README): it isn't a
  user, so it must not be looked up as one. `resolveApiToken` returns its `name` to go by.

### Added

- **Permissions** for tokens, by resource and action: `project`, `members`, `assets`,
  `production`, `workflow`, `exports`, `rights` and `jobs`, each with `read` and its writes
  (`update`, `write`, `manage`, `delete` or `run`), and `projects:create` for the account.
  Every route a token reaches needs its own permission; a route no permission covers isn't
  reachable with a token. A user's token is still limited by its user's role in each project.
  `PROJECT_PERMISSIONS` and `ACCOUNT_PERMISSIONS` are exported.
- **Projects' tokens**, at `GET`, `POST` and `DELETE /projects/:id/api-tokens`, managed by the
  project's admins only. They act on their project alone, with their permissions, and keep
  working after whoever made them leaves it; the project's admins are notified when that
  happens (`api_token_creator_left`). Deleting a project ends its tokens.
- **`projects:create`**: a user's token with it creates projects, and reaches the ones it
  creates.
- **MCP tools** `create_project`, `delete_project`, `delete_asset`, `delete_sequence`,
  `delete_shot` and `delete_task`. Each tool needs its permissions and is listed only for a
  token that has them; the ones that delete are marked as destructive.

## 0.36.0

### Added

- **MCP server** at `POST /mcp`, for agents such as Claude Code to work with StreamBy projects
  with an API token (see the README).
  - It takes only an API token.
  - Its tools call the REST API with that token, so they reach exactly what the token and its
    owner can, and writes are saved as the UI's are.
  - **Reading tools:** projects, assets with their metadata and rights, workflow, pipelines,
    exports, jobs, and production sequences, shots and tasks.
  - **Writing tools**, listed only for `write` tokens: asset metadata and rights, pipelines,
    sequences, shots and tasks.
- **`mcp.rateLimit`** (default 120 requests a minute per token; past it, 429 with
  `Retry-After`) and **`mcp.apiBaseUrl`** in the router config.
- **New table: `mcp_audit`.** It's created at startup in the main database. Every tool call is
  recorded there, with the user, token, project, tool and result, but never the arguments nor
  the token.
- New dependencies: `@modelcontextprotocol/sdk` and `zod`.

### Fixed

- **Projects can be made with PostgreSQL as the main database.** The `projects` table that
  StreamBy creates at startup was missing columns the routes write: `public`, `category`,
  `integrationConnections`, `distributionConnections` and `renderFarmConnections`.
  - Making a project failed with `column "public" does not exist`.
  - Adding service, distribution or render farm connections failed too.
  - They're added at startup now, only where they're missing; databases that already have
    them aren't changed.

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
