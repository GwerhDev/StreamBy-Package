# Changelog

## 0.43.1

### Fixed

- **Inviting a member to a SQL project, or asking to join one, answered 500**: both write who
  invited the member (`invitedBy`), a column `streamby.project_members` didn't have. It's added
  at startup to existing tables, and is in the table made new.
- **Accepting or rejecting an invitation to a SQL project failed too**: they changed the project's
  `members` as a MongoDB project has them, a field a SQL project doesn't have (its members are
  rows of `project_members`); they change the member's row now. A SQL project's members are read
  with `invitedBy`, so whoever invited them is told the answer.

## 0.43.0

### Added

- **License metadata of assets**, for crediting the ones taken from others: `sourceUrl`,
  `creatorName`, `creatorUrl`, `licenseType` and `comments`, all optional, in `asset_rights`.
  The license is one of a closed list (`LICENSE_TYPES`: CC BY, CC BY-SA, CC BY-ND, CC BY-NC,
  CC BY-NC-SA, CC BY-NC-ND, CC0, Free Standard, Standard, Editorial), checked by the server; the
  links are http(s) URLs. It can be given with an upload (query params of `GET .../upload-url`;
  an API token needs `rights:write` too). An `assetRightsEvent` to the project's active members
  on each change, and when an asset is deleted.
- **Credits sheets**: project documents of a new kind, `credits`, that a workflow's Credits sheet
  node makes (`CREDITS_SHEET_NODE`). One keeps only its sources (assets and Storage folders picked,
  and the Ingest nodes connected to its node); its rows are made when it's read, from each asset's
  metadata, with its status: complete when it has an asset and each has its creator, source and
  license. Routes `GET /projects/:projectId/credits-sheets` and `.../credits-sheets/:docId`
  (`rights:read`). Types `CreditsSheet`, `SheetRow`, `SheetSources` and `SheetStatus`.
- MCP: `get_credits_sheet`; `request_asset_upload` takes the license metadata.
- **The workflow defines the project.** Each resource is a node of it, bound by the resource's
  id in its data. A resource added or removed from its section (`POST`/`DELETE` of a connection,
  an API, an export, a pipeline, a project integration) adds or removes its node; saving the
  workflow connects what its nodes were set to (`"__connect__:<integrationId>"`), makes the APIs
  drafted on them (`data.connectionDraft`) and removes the resources whose nodes are gone,
  answering `{ data, project, errors }`. A save needs `baseUpdatedAt` (a 409 over a newer version)
  and a `nodeSchema` with `nodes` and `edges` lists (a 400 otherwise); an app connected with OAuth
  can't remove resources through it (a 403 listing them). Pipelines and exports drafted on nodes
  are made on save too. A node with a configuration of its own (a data source's table, an
  Ingest's file) consumes its resource and is never merged into its node.
  A workflow made before this is brought to it once, when it's read (`resourceNodesAt`).
- **What depends on a resource**, asked before removing it: `GET /projects/:id/dependents/:kind/:resourceId`
  (connections, exports, pipelines): the workflow's, exports' and pipelines' nodes that use it,
  and the files, folders, deliverables and shots kept for it. `GET /user/integrations/:id/dependents`:
  the project connections that use an account's integration.
- **A change to a project's resources answers its list as it is then**, for the client to show
  without asking again: connecting or disconnecting a database (`dbConnections`), a storage
  (`storageConnections`, with built-ins' `available`) or an API (`connections`), deleting an
  export (`exports`) or a pipeline (`pipelines`); `POST`/`DELETE /projects/:id/integrations`
  answer the `project`; deleting an account's integration, each project it was disconnected
  from (`affected`).
- **A built-in connected again keeps the id it had** (`disconnectedBuiltins` on the project; a
  new `disconnectedBuiltins` column in a PostgreSQL projects table, added at startup), so its
  files and records are its own again.

### Changed

- **`asset_rights` holds the license metadata only.** `rightsHolder`, `licenseUrl`, `territory`,
  `expiresAt`, `usageRestrictions` and `notes` are gone: not read, and dropped from a record when
  it's next saved; a `licenseType` off the list reads as none. `set_asset_rights` and
  `get_asset_rights` take and give the new fields.

### Fixed

- Deleting an asset or a project deletes its license metadata (it was left behind).
- A built-in database or storage can be disconnected from a project (it was refused with a 403,
  though the backfill already left a disconnected one alone): what the project keeps in it stays.
- Deleting an account's integration disconnects the project connections that use it (they were
  left pointing at nothing).
- `POST .../connections/db` and `.../connections/storage` with an `integrationId` connect a
  built-in too (they refused it as an unknown integration, and checked the pool's `sql`/`nosql`
  as the type): with an integration, its name and type are the integration's.

## 0.42.0

### Added

- **Project documents**: markdown a project's team reads and edits in the UI, and agents read and
  keep up to date through the MCP server, with every save a version (who saved it, and when). The
  README's Documents section documents them.
  - **New tables: `documents` and `document_versions`.** They're created at startup in the main
    database (collections in MongoDB; in memory without one).
  - Routes under `/projects/:projectId/documents`: the tree, a document, creating, a new version
    (`PATCH` with `baseVersion`; 409 with the document as it is now when it changed since), a
    section's (`PATCH .../sections`), moving and marking exportable, the history
    (`.../versions[/:version]`), publishing a version (`POST .../publish`) and deleting (a folder
    with everything in it). Deleting a project deletes its documents.
  - Permissions `docs:read`, `docs:write`, `docs:publish` and `docs:delete`. Publishing (a
    version for the exports, or whether they deliver it: `POST .../publish`, `PATCH` with
    `exportable`) needs `docs:publish`, not `docs:write`. The OAuth scopes grant reading
    (`streamby:read`) and writing (`streamby:write`); an app publishes and deletes none, whatever
    its scopes: what it edits stays a draft.
  - In MongoDB, a save writes the document and its version in a transaction when the server has
    them (a replica set or a sharded cluster); on a standalone server, two writes.
  - MCP tools `list_documents`, `get_document`, `list_document_versions`, `create_document`,
    `update_document` and `update_document_section`.
  - An export's `documentsNode` delivers the published version of the project's exportable
    documents (all, one folder's, or some), never a draft.
  - A `documentEvent` to the project's active members on each change.
  - Types `ProjectDocument`, `DocumentVersion`, `DocumentAuthor` and `DocumentKind`.

## 0.41.0

### Added

- **OAuth access tokens**: apps the user signs in to with their account (claude.ai's
  connector) work with StreamBy and its MCP server, as a protected resource (RFC 9728). The
  README documents the setup, and how to add the connector in claude.ai.
  - `createOAuthTokenVerifier({ issuer, audiences, jwks })` checks a token with the
    authorization server's keys (RS256, from its JWKS URL or a function), its issuer, its
    audience (one of StreamBy's resources, RFC 8707) and its expiry. The host's `authProvider`
    returns its user with `apiToken: verified.scope` and `oauth: { clientId, clientName? }`.
  - Scopes map to permissions: `streamby:read` to every `:read` one, `streamby:write` to those
    and making and changing; none to deleting nor managing members (`OAUTH_SCOPE_PERMISSIONS`,
    `permissionsForOAuthScopes`). The user's role in each project still applies.
  - An app deletes nothing: its `DELETE` requests answer 403 whatever their route's permission
    (`project:update`, `workflow:write` and `exports:write` reach some that delete), but taking
    a deliverable's mark off. API tokens are unchanged.
  - The router's `oauth` config (`{ issuer, resource, resourceMetadataUrl?, resourceName? }`)
    makes a request without a valid token answer 401 with
    `WWW-Authenticate: Bearer resource_metadata="..."`, and serves the metadata at
    `GET /.well-known/oauth-protected-resource`; `protectedResourceMetadata` builds it for the
    host to serve at its root too.
  - `looksLikeOAuthAccessToken` tells an access token from a host's session tokens.
- `Auth.oauth`: the app a request comes from. A request with it and without `apiToken` is
  refused (an app never gets all of its user's access).

### Changed

- The MCP server takes an OAuth access token too. An app's requests are limited per user it acts
  for, and its tool calls are recorded in `mcp_audit` by its client (`oauthClientId`, a new
  column added at startup) with no `tokenId` (now nullable).

## 0.40.0

### ⚠️ Breaking changes

- **A project's render farm connections are its workers.** `GET`, `POST` and
  `DELETE /projects/:projectId/render-farm-connections` are now
  `/projects/:projectId/workers`, which takes `{ name, provider?, endpoint, credential?, kinds,
  categories, autoKind?, timeoutSeconds?, description? }`. They're still kept in the project's
  `renderFarmConnections` list.
- **Jobs are kept in the main database** (a new `jobs` table, created at startup, or collection),
  not in memory: they survive restarts and every instance sees them. `GET /jobs/:jobId` answers
  from there.
- `canUseBuiltin` may be called with kind `'worker'`.

### Added

- **Processing workers**: StreamBy sends jobs to external workers (the host's, in the router
  config's `workers`; or a project's own) and keeps what they make, as a new asset derived from
  the original or as the asset's new version, with the worker's report. The README documents the
  contract a worker follows.
  - `POST /projects/:projectId/jobs/process` asks for one; `GET /projects/:projectId/jobs` lists
    a project's jobs; `POST /projects/:projectId/jobs/:jobId/retry` sends a failed one again.
  - Workers call back to `/worker-jobs/:jobId/{progress,upload-url,complete,fail}` with a token
    of that job's attempt alone.
  - A job not taken, or not finished in time, is sent again (up to `workerOptions.maxAttempts`);
    every instance looks for them (`workerOptions.sweepIntervalMs`), and only one sends each.
  - A worker with an `autoKind` runs by itself on an asset of its categories marked as a
    deliverable, unless it's marked with an API token without `jobs:run`.
  - **Behind a proxy that ends TLS, set `workerOptions.callbackBaseUrl`** to the router's public
    https URL: without it, the callback URL is made from the request (`req.protocol`), and comes
    out as `http://`.
  - A project's worker is reached only over https and never at a local, private, shared,
    benchmarking, multicast or reserved address: neither as its endpoint is written nor as its
    name resolves, checked when it's connected and again right before each job is sent. A job
    for one that resolves to such an address fails for good. `workerOptions.allowLocalEndpoints`
    lifts that, for development. Its credential is used only while whoever connected it is
    still in the project.
  - A worker's answer to a job it doesn't take is logged, not shown: the job says "The worker
    refused the job".
  - A job is sent as whoever asked for it, with the platform role they had then (a host's
    `canUseBuiltin` decides on sending it as on asking for it).
- MCP tools `list_workers`, `process_asset`, `list_jobs` and `retry_job`.
- Deleting a project deletes its jobs.
- Job events (`jobEvent`) carry the job's `projectId` and `status`.

### Fixed

- **Instances starting together don't deadlock on StreamBy's tables.** The statements that make
  them (or bring them up to date) at startup run one instance at a time, in a transaction that
  holds a transaction-level advisory lock (so it works behind a pooler in transaction mode, such
  as Supabase's).

## 0.39.0

### Added

- **Every resource of a project has its own list**, so a client fetches the one it shows instead
  of the whole project (which still carries them all). New: `GET /projects/:id/exports` (what
  each export is, as the project lists them: not its schema nor its credentials),
  `GET /projects/:id/integrations` and `GET /projects/:id/origins`. They answer `{ data }`, as
  the existing lists do (`connections`, `connections/db`, `connections/storage`, `members`,
  `pipelines`, `workflow`), and are for the project's members. With an API token, the exports
  need `exports:read` and the other two `project:read`.

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

- `GET /projects/:id` answers `hasProductionData`: whether the project has production
  sequences, so a client can show them even without a production node in its workflow.

### Changed

- **Production data is checked before it's saved.** Sequences, shots and tasks need a name
  that isn't blank; a status must be `todo`, `in_progress`, `review` or `done`, and a task's
  priority `low`, `medium` or `high`; a shot's `assignedTo` must list active members of the
  project, and a task's be one of them (or null); a due date must be a date. Otherwise they
  answer 400. A shot is made only in a sequence of the project, and a task only in a shot of
  it (404 otherwise).
- The MCP tools for shots take `assignedTo` as a list of user ids, as the API does, and their
  statuses and priorities are listed in their schema.
- **The MCP tools take the path a user does.** `create_sequence`, `create_shot` and
  `create_task` first add a production node (a Shot node) to the project's workflow when it
  has none, as dropping one on the canvas does, and make nothing if it can't be added. So they
  need `workflow:write` as well as `production:write`. Each tool's description says where its
  result shows in the UI.

### Fixed

- **Deleting production data leaves nothing behind.** Deleting a sequence deletes its shots'
  tasks too (they were left), and deleting a project deletes its sequences, shots, tasks and
  deliverables. Deleting a sequence that doesn't exist answers 404.
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
