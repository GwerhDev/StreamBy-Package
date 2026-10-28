# streamby-core

[![License: AGPL v3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

Middleware framework for building storage-agnostic media APIs.  
Part of the [StreamBy](https://streamby.nhexa.cl) ecosystem by TerminalCore Labs.

---

## 🚀 What is it?

`streamby-core` is a plug-and-play middleware for Express (or compatible frameworks) that enables file uploads, listings and **multi-project access** over services like:

- ✅ AWS S3
- ✅ Google Cloud Storage (soon)
- ✅ Cloudflare R2 (soon)
- ✅ Local/Personal servers (soon)

It's designed to be installed inside your existing API as a library — **no need to run a separate backend**.

---

## 📦 Installation

```bash
npm install streamby-core ws
npm install -D @types/ws
```

---

## 🧱 Basic usage

```ts
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createStreamByRouter } from 'streamby-core';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/streamby/ws' });

app.use('/streamby', express.json(), createStreamByRouter({
  authProvider: async (req) => {
    // validate token/session and return user info
    return { userId: 'user-id', username: 'username', role: 'admin' };
  },
  databases: [
    { id: 'mongo', type: 'nosql', connectionString: process.env.MONGO_URI! },
    { id: 'postgres', type: 'sql', connectionString: process.env.POSTGRES_URI!, main: true },
  ],
  storageProviders: [
    {
      type: 's3',
      config: {
        bucket: process.env.AWS_BUCKET!,
        region: process.env.AWS_REGION!,
        accessKeyId: process.env.AWS_ACCESS_KEY!,
        secretAccessKey: process.env.AWS_SECRET_KEY!,
      },
    },
  ],
  encrypt: process.env.STREAMBY_ENCRYPTION_KEY, // 64 hex characters; see "Encryption and key rotation"
  websocket: { server: wss },
}));

server.listen(3000);
```

> **Important:** use `http.createServer(app)` and pass `server.listen()` instead of `app.listen()`.  
> This is required so the `WebSocketServer` shares the same port as the HTTP server.

---

## 🔑 Encryption and key rotation

Credentials stored by StreamBy (connection secrets, export credentials, user integrations,
distribution and render farm credentials) are encrypted with the key you pass as `encrypt`:
32 bytes, written as 64 hexadecimal characters. Each stored value records the id of the key
that encrypted it (a fingerprint, never the key itself), so you can rotate the key:

1. Generate a new key, for example with `openssl rand -hex 32`.
2. Pass the new key as `encrypt` and the previous one in `encryptPreviousKeys`.
3. Restart. Values encrypted with a previous key still decrypt, and at startup StreamBy
   re-encrypts all of them with the new key.
4. Once that's done (the startup log says how many records it re-encrypted, and none are left
   on the old key), you can remove the old key from `encryptPreviousKeys`.

```ts
createStreamByRouter({
  // ...
  encrypt: process.env.STREAMBY_ENCRYPTION_KEY,               // the current key
  encryptPreviousKeys: [process.env.STREAMBY_PREVIOUS_KEY!],  // only while rotating
});
```

> Upgrading from a version before 0.34.0: deploy with your current key first, and rotate only
> after that deploy (see the [changelog](CHANGELOG.md)).

---

## 🎫 API tokens

Agents and services work with StreamBy through API tokens, without a browser session. There
are two kinds:

- **A user's token** acts as its user. The user manages their own (`GET`, `POST` and
  `DELETE /streamby/user/api-tokens`). It reaches a list of the user's projects, or `'*'` for
  every project they're a member of, including ones they join later. It never does more than
  its user can: their role in each project still applies.
- **A project's token** acts on its project alone, as the project's, not as whoever made it:
  it keeps working after they leave the project, for permanent integrations (CI, services, the
  project's agents). Only the project's admins list, make and revoke them (`GET`, `POST` and
  `DELETE /streamby/projects/:id/api-tokens`), and each one records who made it. When they
  leave, the project's admins are notified that it still works. Deleting the project ends
  its tokens.

Tokens are managed only with a session: a token can't manage tokens.

Each token has a name, **its permissions**, and **an expiry** (7, 30, 90 or 365 days, or
none). It's `sbt_` followed by 32 random bytes, shown once, when it's made. Only its SHA-256
hash is stored, with a short prefix to tell it apart.

**Permissions**

| Resource | Permissions | Covers |
|---|---|---|
| Project | `project:read`, `project:update`, `project:delete` | The project, its settings and its connections (API, database, storage, distribution, render farm), integrations and allowed origins. |
| Members | `members:read`, `members:manage` | Listing members; inviting, changing and removing them, and searching users. |
| Assets | `assets:read`, `assets:write`, `assets:delete` | Files and folders, upload URLs, metadata, versions, reviews and annotations, QC reports. |
| Production | `production:read`, `production:write`, `production:delete` | Sequences, shots and tasks. |
| Workflow | `workflow:read`, `workflow:write` | The workflow and its pipelines. |
| Exports | `exports:read`, `exports:write` | The project's exports. |
| Rights | `rights:read`, `rights:write` | Assets' license metadata, and reading credits sheets. |
| Jobs | `jobs:read`, `jobs:run` | Following jobs; starting them (transcoding, rendering, AI, publishing a deliverable). |
| Documents | `docs:read`, `docs:write`, `docs:publish`, `docs:delete` | The project's documents: reading them and their history; creating, editing and moving them; publishing them (the version its exports deliver, and whether they deliver it); deleting them. |
| Account | `projects:create` | Creating projects. A user's token only; the token reaches what it creates. |

`PROJECT_PERMISSIONS` and `ACCOUNT_PERMISSIONS` are exported. A route no permission covers
(the user's notifications, integrations and tokens, Explore, accepting an invitation) isn't
reachable with a token.

**Resolving a token**

Requests send it as `Authorization: Bearer sbt_...`. Your `authProvider` resolves it with
`resolveApiToken`, and returns its `userId` with the token's scope in `apiToken`. A project's
token isn't a user: its `userId` is the token's own (on its project), and it goes by its name.

```ts
import { createStreamByRouter, resolveApiToken, API_TOKEN_PREFIX } from 'streamby-core';

createStreamByRouter({
  // ...
  authProvider: async (req) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (bearer?.startsWith(API_TOKEN_PREFIX)) {
      const resolved = await resolveApiToken(bearer); // null once revoked or expired
      if (!resolved) throw new Error('Invalid API token');
      if (resolved.scope.kind === 'project') {
        return { userId: resolved.userId, username: resolved.name, role: 'viewer', apiToken: resolved.scope };
      }
      const user = await findUser(resolved.userId);   // your own user lookup
      return { userId: user.id, username: user.username, role: user.role, apiToken: resolved.scope };
    }
    // ...your session-based authentication
  },
});
```

A request made with a token goes through only when its route's permission is among the
token's (otherwise 403), and a project outside the token's projects answers 404; the project
list shows only the token's projects.

---

## 🔐 OAuth: apps the user signs in to

An app the user signs in to with their account, such as claude.ai's connector, works with
StreamBy through an **OAuth access token**, not an API token. StreamBy is the protected resource
(RFC 9728); the tokens are issued by the host's authorization server (for Nhexa, Nhexa-API).

A token is a JWT the server signs with RS256 for one resource (its audience, RFC 8707), checked
with the server's published keys (JWKS) alone: no secret is shared. It reaches what the user
approved, and never more than the user can: their role in each project still applies.

| Scope | Permissions |
|---|---|
| `streamby:read` | Every `:read` permission: `project:read`, `members:read`, `assets:read`, `production:read`, `workflow:read`, `exports:read`, `rights:read`, `jobs:read`, `docs:read`. |
| `streamby:write` | Those, and making and changing: `project:update`, `assets:write`, `production:write`, `workflow:write`, `exports:write`, `rights:write`, `jobs:run`, `projects:create`, `docs:write`. |

No scope grants deleting (`*:delete`, `project:delete`) nor managing members. And since some
write permissions also reach routes that delete (`project:update` a connection, a worker or an
integration; `workflow:write` a pipeline; `exports:write` an export), **an app's `DELETE` is
refused (403) whatever its route**, but taking a deliverable's mark off, which only forgets the
mark (the asset stays). Nor does an app publish a document (`POST .../publish`, or a `PATCH`
changing `exportable`), whatever its scopes: what it edits stays a draft until someone publishes
it. API tokens aren't affected. Other scopes (`profile`, `email`) grant nothing in StreamBy. `OAUTH_SCOPE_PERMISSIONS` is exported.

**Telling clients where to sign in**

Set `oauth` in the router's config. A request without a valid token then gets a 401 with
`WWW-Authenticate: Bearer resource_metadata="..."`, and the metadata says which authorization
server to use. The router serves it at `GET /streamby/.well-known/oauth-protected-resource`;
serve it at your root too, where RFC 9728 puts it (`resourceMetadataUrl` defaults to that):

```ts
import express from 'express';
import { createStreamByRouter, protectedResourceMetadata } from 'streamby-core';

const oauth = { issuer: 'https://api.example.com', resource: 'https://api.example.com/streamby/mcp' };
app.get('/.well-known/oauth-protected-resource/streamby/mcp', (_req, res) => res.json(protectedResourceMetadata(oauth)));
app.use('/streamby', createStreamByRouter({ /* ... */ oauth }));
```

**Validating a token (your `authProvider`)**

Your `authProvider` checks the token with `createOAuthTokenVerifier` and returns the user, with
the token's scope in `apiToken` and the app in `oauth`. A request with `oauth` but no `apiToken`
is refused, so an app never gets all of its user's access. `looksLikeOAuthAccessToken` tells the
token from your own session tokens.

```ts
import { createOAuthTokenVerifier, looksLikeOAuthAccessToken, API_TOKEN_PREFIX } from 'streamby-core';

const verifyOAuthToken = createOAuthTokenVerifier({
  issuer: 'https://api.example.com',
  // What a token may be for: StreamBy's resources.
  audiences: ['https://api.example.com/streamby', 'https://api.example.com/streamby/mcp'],
  // The server's JWKS URL, or a function giving its keys (when the host is the server itself).
  jwks: 'https://api.example.com/.well-known/jwks.json',
});

createStreamByRouter({
  // ...
  authProvider: async (req) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (bearer?.startsWith(API_TOKEN_PREFIX)) { /* an API token, as above */ }
    if (looksLikeOAuthAccessToken(bearer)) {
      const verified = await verifyOAuthToken(bearer); // null: forged, expired, or for another resource
      if (!verified) throw new Error('Invalid OAuth access token');
      // Optional but recommended: has the user taken the app's access away? (your own records)
      if (!(await stillConnected(verified.userId, verified.clientId))) throw new Error('Access revoked');
      const user = await findUser(verified.userId);
      return {
        userId: user.id, username: user.username, role: user.role,
        apiToken: verified.scope,
        oauth: { clientId: verified.clientId, clientName: 'Claude' }, // the name, if you know it
      };
    }
    // ...your session-based authentication
  },
});
```

The verifier keeps the keys for 5 minutes (`jwksCacheMs`) and fetches them again for a key id it
doesn't know (a rotation), at most once a minute. It doesn't know whether the user has since
taken the app's access away: without that check, a revoked app keeps its access until its access
token expires (Nhexa's last an hour). Nhexa-API checks the user's consent on every request, so
taking the access away in accounts.nhexa.cl ends it at once.

---

## 🤖 MCP server

StreamBy serves an [MCP](https://modelcontextprotocol.io) server at `POST /streamby/mcp`
(Streamable HTTP, stateless). Agents such as Claude Code use it to read and work on StreamBy
projects with an API token, and apps the user signed in to (claude.ai's connector) with an OAuth
access token (see above). A browser session gets 401.

Each tool calls StreamBy's own REST API with the caller's token. So it reaches exactly what the
token allows (and, for a user's token or an app, what the user's role in each project allows), and a
change is saved just like one made from the UI, which shows it when it loads the project.

**Tools**

A token sees only the tools whose permissions it has (an app: those its scopes grant).

| Tools | Permissions |
|---|---|
| `list_projects` | any token |
| `get_project` | `project:read` |
| `create_project` | `projects:create` |
| `delete_project` | `project:delete` |
| `list_assets` (by category, optionally in one storage connection, and filtered by name), `get_asset_metadata` | `assets:read` |
| `update_asset_metadata` | `assets:write` |
| `delete_asset` | `assets:delete` |
| `get_asset_rights`, `get_credits_sheet` / `set_asset_rights` | `rights:read` / `rights:write` |
| `get_workflow`, `list_pipelines`, `get_pipeline` | `workflow:read` |
| `create_pipeline`, `update_pipeline` | `workflow:write` |
| `list_exports` | `project:read` and `exports:read` |
| `get_export` | `exports:read` |
| `get_job`, `list_jobs` | `jobs:read` |
| `list_workers` | `project:read` |
| `process_asset`, `retry_job` | `jobs:run` |
| `list_sequences`, `list_shots`, `list_tasks` | `production:read` |
| `update_sequence`, `update_shot`, `update_task` | `production:write` |
| `create_sequence`, `create_shot`, `create_task` | `production:write` and `workflow:write` |
| `delete_sequence`, `delete_shot`, `delete_task` | `production:delete` |
| `list_asset_versions`, `get_asset_download_url`, `list_deliverables` | `assets:read` |
| `request_asset_upload` (with license metadata, also `rights:write`), `mark_deliverable`, `remove_deliverable` | `assets:write` |
| `list_documents`, `get_document`, `list_document_versions` | `docs:read` |
| `create_document`, `update_document`, `update_document_section` | `docs:write` |

The tools take the path a user does in the UI, and each one's description says where its
result shows there. Production data lives under a production node of the project's workflow:
if the workflow has none yet, `create_sequence`, `create_shot` and `create_task` first add a
Shot node to it, as dropping one on the canvas does (so they need `workflow:write`), and make
nothing if it can't be added.

The tools that delete are marked as destructive (`destructiveHint`), so a client can ask before
running them.

**Files**

A file never goes through the conversation. `request_asset_upload` makes a new asset (or a new
version of one) and gives a signed URL to `PUT` its bytes to; `get_asset_download_url` gives a
signed URL to `GET` an asset's file, its latest version or any earlier one. The tool that has
the file uploads or downloads it directly, for example Blender's or Godot's own MCP server,
which can run code. Each URL is for that one file, and given to an API token it works only
briefly: 15 minutes to upload, 5 to download (`mcp.signedUrlTtl`).

**Versions.** Replacing an asset doesn't change its URL: the new version is uploaded to the
asset's own key, so a site that links to the asset shows the new one with no deploy. Before
that, the current version is copied to a key of its own (`<key>.v<n>.<ext>`) and recorded, so
every earlier version can still be downloaded by its id; if it can't be copied, nothing is
replaced. A storage adapter keeps versions only if it can copy (`copyFile`; the S3 one does);
otherwise asking for a new version answers 501. Deleting the asset deletes every key of it.

Since the URL stays the same, a browser or a CDN may keep serving the earlier version for a
while. StreamBy doesn't set `Cache-Control` on uploads (a signed URL that did would require
every client to send the same header): set it where the files are served, for example a short
`max-age` or `no-cache` on the CDN in front of the bucket, or invalidate the path when an asset
is replaced.

A **deliverable** is an asset, or one of its versions, delivered for a
production shot or for an export; a shot or an export can have several, and the shot's panel
in the UI shows them.

For example, with Claude connected to StreamBy and to Blender's MCP server, asking *"export the
scene as glTF and deliver it for shot SH010 of Portfolio"* goes:

1. `list_projects`, `list_sequences`, `list_shots`: the project and the shot's id.
2. `request_asset_upload` with `category: '3d-models'`, `fileName: 'SH010_layout.glb'` and
   `contentType: 'model/gltf-binary'`: the new asset's id, and where to upload it.
3. In Blender, code that exports the scene and uploads it:

   ```python
   import bpy, urllib.request
   path = bpy.app.tempdir + "SH010_layout.glb"
   bpy.ops.export_scene.gltf(filepath=path, export_format="GLB")
   with open(path, "rb") as f:
       req = urllib.request.Request(UPLOAD_URL, data=f.read(), method="PUT",
                                    headers={"Content-Type": "model/gltf-binary"})
   urllib.request.urlopen(req)
   ```

4. `mark_deliverable` with the asset's id and `shotId`: it shows in the shot's panel.

Bringing an asset into Blender or Godot is the other way around: `get_asset_download_url`, and
code there that downloads the URL and imports the file (in Blender,
`bpy.ops.import_scene.gltf(filepath=...)`). A new version of the same asset is
`request_asset_upload` with its `assetId`.

**Limits and audit**

- Each token can make at most 120 requests a minute (a sliding window); an app, per user it acts
  for. Past that, StreamBy answers 429 with `Retry-After`. Each instance counts its own
  requests. Change the limit with `mcp.rateLimit`.
- Every tool call is recorded in the `mcp_audit` table, created at startup in the main database.
  Each row has the user (a project's token: the token itself), the token's id (an app's call:
  its OAuth client, in `oauthClientId`, and no token), the project, the tool, whether it went
  through, the status, the error and the duration. A row never includes the arguments or the
  token.

```ts
createStreamByRouter({
  // ...
  mcp: {
    rateLimit: { requests: 120, windowMs: 60_000 }, // the default
    signedUrlTtl: { upload: 900, download: 300 },   // the default, in seconds
    // apiBaseUrl: 'http://127.0.0.1:3000/streamby', // where tools reach the REST API;
    //   by default this same process, at the request's local port and mount path
  },
});
```

### Connecting from Claude Code

Make an API token in StreamBy, with only the permissions the agent needs: your own
(Settings → Security → Personal API tokens), or a project's (in the project, Settings → API
Tokens). Keep it in an environment variable, never in a file:

```bash
export STREAMBY_TOKEN=sbt_...
```

Add the server to your project's `.mcp.json`. Claude Code expands `${STREAMBY_TOKEN}` from the
environment:

```json
{
  "mcpServers": {
    "streamby": {
      "type": "http",
      "url": "https://your-host/streamby/mcp",
      "headers": { "Authorization": "Bearer ${STREAMBY_TOKEN}" }
    }
  }
}
```

### Connecting from Claude Desktop

Claude Desktop runs local (stdio) servers from `claude_desktop_config.json`. Reach StreamBy
through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), passing the token in its
`env`. This file holds it in plain text, so use a token with only the permissions you need,
and an expiry:

```json
{
  "mcpServers": {
    "streamby": {
      "command": "npx",
      "args": ["mcp-remote", "https://your-host/streamby/mcp", "--header", "Authorization:${STREAMBY_AUTH}"],
      "env": { "STREAMBY_AUTH": "Bearer sbt_..." }
    }
  }
}
```

### Connecting from claude.ai

claude.ai connects through a custom connector, which signs in with OAuth (see above): nobody on
the team sets up a token or a file. Each person signs in with their own account and approves what
Claude may do, and Claude reaches only that, and only what their role in each project allows.

- **For yourself**: in claude.ai, Settings → Connectors → Add custom connector. Give it a name
  (StreamBy) and the server's URL, `https://your-host/streamby/mcp`, and add it. Then Connect:
  claude.ai opens the sign-in page, and after you sign in, the consent screen, with what it asks
  for (`streamby:read`, and `streamby:write` to make and change things). Approve it.
- **For your organization** (Team and Enterprise plans): an owner adds it once in Organization
  settings → Connectors, with the same URL; each member then connects it with their own account
  from their Settings → Connectors.

claude.ai registers itself with the authorization server (dynamic client registration or a
client ID metadata document), so there's nothing to set up there. To take its access away, the
person removes it in their account's connected apps (in Nhexa, accounts.nhexa.cl → Aplicaciones
→ Quitar acceso), or disconnects it in claude.ai.

---

## 📄 Documents

Each project keeps its documents: markdown its team reads and edits (its concept, its
architecture, its decisions), and agents read and keep up to date through the MCP server. They're
kept in the main database (the `documents` and `document_versions` tables, created at startup,
or collections), each one in a single project, in folders.

- **Every save is a version**, with who saved it and when: a user, an API token, or an app on a
  user's behalf (`{ userId, username, via: 'session' | 'apiToken' | 'oauth', tokenId?, clientId?, clientName? }`).
- **Nothing is overwritten without notice.** A change says the version it was made on
  (`baseVersion`); if someone saved another one since, it's refused with a 409 and the document
  as it is now, to read again.
- **A section** is what's under a heading (`## Architecture`), up to the next one of the same
  level or above: it can be replaced alone, the rest untouched.
- **Drafts and published versions.** A document marked exportable delivers, through the project's
  exports, only the version published from its history; editing it changes nothing exported until
  another version is published. An export's `documentsNode` (on the StreamBy node's data input)
  delivers them, `[{ id, title, parentId, position, version, content, publishedAt }]`: all the
  project's, those in one folder (`data.folderId`), or some (`data.documentIds`).
- **In real time**, a `documentEvent` reaches the project's active members on each change:
  `{ projectId, action: 'created' | 'saved' | 'changed' | 'deleted', documentIds, version?, title?, author }`
  (`saved` is a new version; `changed`, a move or a publication).

| Route | Permission |
|---|---|
| `GET /projects/:projectId/documents`: the tree, without contents | `docs:read` |
| `POST /projects/:projectId/documents` `{ title, content?, kind?: 'document' \| 'folder' \| 'credits', parentId?, position? }` | `docs:write` |
| `GET /projects/:projectId/documents/:docId` | `docs:read` |
| `PATCH /projects/:projectId/documents/:docId` `{ baseVersion, title?, content? }` (a new version) and/or `{ parentId?, position? }` | `docs:write` |
| `PATCH /projects/:projectId/documents/:docId` `{ exportable }` | `docs:write` and `docs:publish` |
| `PATCH /projects/:projectId/documents/:docId/sections` `{ baseVersion, heading, content }` | `docs:write` |
| `GET /projects/:projectId/documents/:docId/versions` and `/versions/:version` | `docs:read` |
| `POST /projects/:projectId/documents/:docId/publish` `{ version }` (`null`: none) | `docs:publish` |
| `DELETE /projects/:projectId/documents/:docId` (a folder, with everything in it) | `docs:delete` |

Editors and admins create, edit, publish and delete them; viewers read them. An app connected
with OAuth reads and edits them, but publishes and deletes none: what it edits stays a draft.

In MongoDB, a save writes the document and its version in a transaction when the server has them
(a replica set or a sharded cluster). A standalone server doesn't: there they're two writes.

---

## ©️ License metadata and credits sheets

Each asset can carry its **license metadata**, for all its versions: where it was taken from
(`sourceUrl`), who made it (`creatorName`, `creatorUrl`), its license (`licenseType`) and
`comments`. All are optional; the links are http(s) URLs, and the license is one of
`CC BY`, `CC BY-SA`, `CC BY-ND`, `CC BY-NC`, `CC BY-NC-SA`, `CC BY-NC-ND`, `CC0`, `Free Standard`,
`Standard` and `Editorial` (`LICENSE_TYPES`, exported). It's kept in the `asset_rights`
collection, the only place it lives, and goes with its asset or its project when they're deleted.
It can be given with the upload: `licenseType`, `sourceUrl`, `creatorName`, `creatorUrl` and
`comments` as query params of `GET .../upload-url` (an API token needs `rights:write` too).

A **credits sheet** is a project document of kind `credits`, made by a Credits sheet node of the
workflow (its `data.documentId`). It keeps only what feeds it, as its content:
`{ "assetIds": [...], "folderIds": [...] }` (assets and Storage folders picked, with everything
inside them); the Ingest nodes connected to its node feed it too, with the asset each imports
(`data.fileId`). Its rows are made each time it's read, from each asset's metadata, so two sheets
with the same asset show the same, and editing a row is setting its asset's metadata. Deleting
the node leaves the document; an asset deleted leaves the sheet.

A sheet is **complete** when it has an asset and each one has its creator, source and license;
**incomplete** otherwise, each row listing what it lacks (`missing`).

- **In real time**, an `assetRightsEvent` reaches the project's active members on each change:
  `{ projectId, action: 'saved' | 'deleted', assetIds, rights? }` (`deleted`: the asset is gone).

| Route | Permission |
|---|---|
| `GET /projects/:projectId/assets/:assetId/rights` | `rights:read` |
| `PUT /projects/:projectId/assets/:assetId/rights` `{ sourceUrl?, creatorName?, creatorUrl?, licenseType?, comments? }` (the fields given; empty or `null` clears one) | `rights:write` |
| `GET /projects/:projectId/credits-sheets`: each with `{ id, title, status, rows, incomplete }` | `rights:read` |
| `GET /projects/:projectId/credits-sheets/:docId`: `{ document, sources, rows, status }` | `rights:read` |

Each row: `{ assetId, name, category, sourceUrl, creatorName, creatorUrl, licenseType, comments, missing, from }`,
`from` saying how it got there (`asset`, `folder`, `ingest`). Editors and admins set the metadata
(as they edit the asset); every member reads it.

---

## ⚙️ Processing workers

StreamBy doesn't process assets itself (optimizing a glTF, making LODs, transcoding...): it
sends the work to a **worker**, an external service, and keeps what it makes. Anyone can write a
compatible worker by following the contract below.

**Where workers come from**

- **The host's**, offered to every project, in the router config (each one gated, like the other
  built-ins, by `canUseBuiltin` with kind `'worker'`):

  ```ts
  createStreamByRouter({
    // ...
    workers: [{
      id: 'gltf', name: 'glTF optimizer',
      endpoint: 'https://worker.example.com/jobs', credential: process.env.GLTF_WORKER_TOKEN,
      kinds: ['gltf-optimize', 'lod'],   // what it does
      categories: ['3d-models'],         // the assets it takes
      autoKind: 'gltf-optimize',         // optional: run on its own (see below)
      timeoutSeconds: 3600,              // optional: how long it may take a job
    }],
    workerOptions: {
      callbackBaseUrl: 'https://api.example.com/streamby', // where workers call back (see below)
      maxAttempts: 3,           // how many times a job is sent before it fails
      sweepIntervalMs: 30_000,  // how often each instance looks for jobs to send again
    },
  });
  ```

- **A project's own**, connected from the project (`GET`, `POST` and
  `DELETE /projects/:projectId/workers`; a project's render farms are workers too). Its endpoint
  must be https and never reach a local or private address: not as written, nor as its name
  resolves, which is checked when it's connected and again right before each job is sent (a
  name can point at the server's own network, or start pointing there later). A job for one
  that resolves to such an address fails for good. `workerOptions.allowLocalEndpoints` lifts
  all this, for development. Its credential is stored encrypted, and used only while whoever
  connected it is still in the project.

  The host's own workers aren't checked this way: the host chose them, and they may well be on
  its private network.

`GET /projects/:projectId/workers` lists the workers a member can use.

**Asking for a job**

`POST /projects/:projectId/jobs/process` with
`{ assetId, versionId?, worker: { source: 'builtin' | 'project', id }, kind, profile?, resultMode? }`
(editors and admins; an API token needs `jobs:run`, and the MCP server has `process_asset`).
`resultMode` decides where the result goes:

- `'derived'` (the default): a new asset, linked to the original (`derivedFrom`), which is never
  touched;
- `'version'`: the asset's new version, at its own key, so its URL serves the result; the
  version it replaces is archived, and can still be downloaded.

A worker with an `autoKind` also runs by itself on an asset of its categories when it's marked
as a deliverable (by a session, or by an API token that has `jobs:run`: one without it marks the
deliverable and starts nothing).

Jobs are kept in the main database (a `jobs` table or collection): they survive restarts, and
every instance sees them. `GET /projects/:projectId/jobs` lists them (`?assetId=` for one asset's);
`POST /projects/:projectId/jobs/:jobId/retry` sends a failed one again.

**The contract: what a worker receives**

StreamBy sends each job with a `POST` to the worker's endpoint
(`Authorization: Bearer <the worker's credential>`):

```json
{
  "jobId": "…", "kind": "gltf-optimize", "profile": { "textureFormat": "ktx2" }, "attempt": 1,
  "asset": { "id": "…", "versionId": null, "fileName": "hero.glb", "contentType": "model/gltf-binary", "category": "3d-models" },
  "download": { "url": "https://…signed…", "expiresAt": "…" },
  "callback": { "url": "https://api.example.com/streamby/worker-jobs/<jobId>", "token": "…" },
  "deadline": "…"
}
```

The worker answers `2xx` to take it (any other answer, or none, and the job is sent again later),
downloads the asset with `download.url`, and does its work before `deadline`.

`callback.url` is `workerOptions.callbackBaseUrl` plus the job's path. Without it, it's made
from the request that asked for the job (`req.protocol` and its host): behind a proxy that ends
TLS (and without Express's `trust proxy`), that comes out as `http://`, which a worker can't call
back to. Set `callbackBaseUrl` to the router's public https URL.

**The contract: what a worker calls back**

Every callback is a `POST` to `callback.url` plus an action, with
`Authorization: Bearer <callback.token>`. The token is the job's for this attempt alone: a
callback without it, with another, or after the job ended answers 401.

| Action | Body | Answer |
|---|---|---|
| `/progress` | `{ "progress": 0-100, "stage": "optimizing" }` (either) | the job |
| `/upload-url` | `{ "fileName": "hero.glb", "contentType": "model/gltf-binary" }` (of the asset's category) | `{ "url", "method": "PUT", "headers", "expiresAt" }`: upload the result there |
| `/complete` | `{ "report": { … } }` (optional; any JSON object, kept with the result) | the job, completed, with its `result`: `{ assetId, versionId, mode }` |
| `/fail` | `{ "error": "…", "retryable": false }` | the job, failed with its error (sent again if `retryable` and attempts are left) |

A job its worker doesn't complete before its deadline is sent again, up to
`workerOptions.maxAttempts` times; then it fails, with its error, and can be retried.

---

## 🧭 The workflow defines the project

Each of a project's resources (a database, an API, a storage, a service, an export, a pipeline)
is a node of its workflow, bound to it by the resource's id in its data (`connectionId`,
`storageConnectionId`, `integrationConnectionId`, `exportId`, `pipelineId`). One node per
resource; a data source reading one of a database's tables is a node of its own.

- **From a section** (or an agent): adding a resource adds its node to the saved workflow, and
  removing it removes its nodes.
- **Saving the workflow** (`PATCH /projects/:id/workflow` `{ nodeSchema, baseUpdatedAt }`) makes
  the project what it defines, then answers `{ data, project, errors }`: the workflow, the
  project's lists as they are then, and what couldn't be done. A node set to an integration the
  project doesn't have (`"__connect__:<integrationId>"`) connects it; an API, a pipeline or an
  export drafted on a node (`data.connectionDraft`, `data.pipelineDraft`, `data.exportDraft`) is
  made; a resource whose nodes are all gone is removed.
  - `baseUpdatedAt` (the workflow's `updatedAt` as it was read) is required with a `nodeSchema`,
    and `nodeSchema` must be `{ nodes: [...], edges: [...] }`: a 400 otherwise. Saved over a newer
    version, it's a 409 with the workflow as it is now.
  - An app connected with OAuth removes nothing through it, as it deletes nothing: a save that
    would remove resources is a 403 listing them (`removing`).
  - A node holding a configuration of its own beside its resource's id (a data source reading one
    table, an Ingest importing one file) consumes the resource: never merged into its node.
- **Reading it** (`GET`) never rewrites it, except once, for a workflow made before this: the
  nodes once drawn from the project's lists are bound by their ids, a resource without a node gets
  one, and two nodes of the same resource are merged.

---

## 🔌 Removing a project's resources

Before a connection (database, API, storage, service), an export or a pipeline is removed, the
UI asks what depends on it: `GET /projects/:id/dependents/:kind/:resourceId` (`kind`: `db`,
`api`, `storage`, `service`, `export`, `pipeline`; `project:read`) answers
`{ dependents: [{ type, name, id?, count? }] }`: the nodes that use it in the workflow, the
exports and the pipelines (`workflow`, `export`, `pipeline`: they stop working without it), and
what's kept for it (`files` and `folders` of a storage, `deliverables` and `shots` of an
export). Removing it changes none of them.

**Built-ins** (the host's database and storage) are disconnected like any connection, and what
the project keeps in them stays. They're connected again as any integration is, by its id in
the pool (`GET /user/integrations`): `POST /projects/:id/integrations` `{ integrationId }`, or
`POST .../connections/db` and `.../connections/storage` with `integrationId` (its name and type
come from the integration). One connected again keeps the id it had (`disconnectedBuiltins`
on the project), so its files and records are its own again.

Deleting an account's integration disconnects the project connections that use it;
`GET /user/integrations/:id/dependents` lists them first.

---

## 👥 Project roles

What a user can do in a project depends on their role in that project, as an active member
(an invitation counts once it's accepted). It never depends on the platform role your
`authProvider` returns.

| Role | Can |
|---|---|
| `viewer` | See the project and its content, and archive the project in their own list. |
| `editor` | Everything a viewer can, plus change the project: its details, connections, exports, files and folders, workflow, pipelines, production, reviews, rights, documents, and start jobs. |
| `admin` | Everything an editor can, plus manage the project's members and delete the project. |

A project's public exports (`GET /streamby/:projectId/export/:exportName`) are read without a
session. They only run nodes that read data: never a node that uses an account's credential,
nor one that starts a job.

---

## 🗄️ Database Schema Setup

`streamby-core` requires a pre-configured database schema for its internal operations. It does not manage database connections directly; instead, it expects the host application to provide initialized connection instances. This ensures full control and flexibility for the host environment.

The library will only interact with the specified schema and will not touch other schemas in your database. The `reset` option is opt-in and will only drop and recreate the specified `streamby` schema if explicitly set to `true`.

### PostgreSQL Example

```ts
import { Pool } from "pg";
import { setupStreambyPg } from "streamby-core/pg/setup"; // Adjust path as per your package structure

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Call setupStreambyPg to ensure the schema and tables are created
// reset: false (default) ensures idempotency and no data loss
await setupStreambyPg({ pool, schema: "streamby", reset: false });
```

### MongoDB Example

```ts
import { MongoClient } from "mongodb";
import { setupStreambyMongo } from "streamby-core/mongo/setup"; // Adjust path as per your package structure

const client = new MongoClient(process.env.MONGO_URL!);

// Connect the MongoDB client
await client.connect();

// Call setupStreambyMongo to ensure collections and indexes are created
await setupStreambyMongo({ client, dbName: "streamby" });
```

```ts
import express from 'express';
import { createStreamByRouter } from 'streamby-core';

const app = express();

app.use('/streamby', createStreamByRouter({
  storageProvider: {
    type: 's3',
    config: {
      bucket: 'your-bucket-name',
      region: 'your-region',
      accessKeyId: 'YOUR_AWS_KEY',
      secretAccessKey: 'YOUR_AWS_SECRET'
    }
  },
  authProvider: async (req) => {
    // extract token/cookie and validate
    return {
      userId: 'demo',
      projects: ['demo-project'],
      role: 'admin',
    };
  },
  projectProvider: async (projectId) => {
    // fetch project from your DB
    return {
      id: projectId,
      name: 'Demo Project',
      description: 'Demo for StreamBy integration',
      rootFolders: [],
      settings: { allowUpload: true }
    };
  }
}));

app.listen(3000);
```

---

## 🧪 Testing

```bash
npm run test
```

Unit tests use [Vitest](https://vitest.dev) and [Supertest](https://www.npmjs.com/package/supertest).

---

## 📁 Features

- 📂 Multi-project access control
- 🔐 Project-aware file uploads & listings
- 🧹 Modular adapters per storage provider
- 🧰 Built-in testability with mock auth & storage
- ✨ Simple to extend for custom business logic

---

## 🗺️ API Endpoints

Here's a summary of the key API endpoints provided by `streamby-core`:

### `GET /streamby/projects`

Lists all projects accessible by the authenticated user.

**Query Parameters:**
- `archived`: (Optional) Filter projects by their archived status.
  - `true`: Returns only archived projects.
  - `false`: Returns only unarchived projects.
  - (Omitted): Returns all projects (both archived and unarchived).

**Example Response:**
```json
{
  "projects": [
    {
      "id": "project1_id",
      "dbType": "nosql",
      "name": "My NoSQL Project",
      "image": "url_to_image",
      "archived": false
    },
    {
      "id": "project2_id",
      "dbType": "sql",
      "name": "My SQL Project",
      "image": "url_to_image",
      "archived": true
    }
  ]
}
```

### `PATCH /streamby/projects/:id/archive`

Archives a specific project. After archiving, it returns the complete list of projects for the user, including the updated project.

**Example Response:**
```json
{
  "success": true,
  "projects": [
    {
      "id": "project1_id",
      "dbType": "nosql",
      "name": "My NoSQL Project",
      "image": "url_to_image",
      "archived": true
    },
    {
      "id": "project2_id",
      "dbType": "sql",
      "name": "My SQL Project",
      "image": "url_to_image",
      "archived": false
    }
  ]
}
```

### `PATCH /streamby/projects/:id/unarchive`

Unarchives a specific project. After unarchiving, it returns the complete list of projects for the user, including the updated project.

**Example Response:**
```json
{
  "success": true,
  "projects": [
    {
      "id": "project1_id",
      "dbType": "nosql",
      "name": "My NoSQL Project",
      "image": "url_to_image",
      "archived": false
    },
    {
      "id": "project2_id",
      "dbType": "sql",
      "name": "My SQL Project",
      "image": "url_to_image",
      "archived": false
    }
  ]
}
```

---

## 🚣 Roadmap

- [ ] Support for Google Cloud Storage
- [ ] CLI tool for uploading files
- [ ] Role-based access control middleware
- [ ] Plugin system for extended routes
- [ ] Streaming support (HLS, audio, etc.)

---

## 🧑‍💻 Maintained by

**TerminalCore Labs** – part of [Nhexa Entertainment](https://nhexa.cl)  
Developed as open-source infrastructure for creative and media-oriented apps.

Visit us [here](https://terminalcore.cl)

---

## 📟 License

Copyright (C) 2026 TerminalCore Labs

Licensed under the [GNU Affero General Public License v3.0](./LICENSE) (AGPL-3.0-only).

> **Note for consumers:** unlike most installable packages, this one is intentionally AGPL rather than MIT. AGPL's copyleft applies to any project that depends on it -- if you install `streamby-core`, your own project must also be licensed under AGPL-3.0 (or a compatible copyleft license). Confirm this is acceptable for your use case before adding this dependency.

