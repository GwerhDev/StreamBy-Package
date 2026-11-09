# streamby-core

[![License: AGPL v3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

The backend of [StreamBy](https://streamby.nhexa.cl), installed inside your own API: a
production platform for creative teams, from a project's files to what it delivers. Part of the
StreamBy ecosystem by TerminalCore Labs.

---

## 🚀 What is it?

`streamby-core` is an Express middleware (`createStreamByRouter`) that gives your API, under one
path, everything a StreamBy project needs. It's a library: **no separate backend to run**. Your
app authenticates (`authProvider`), StreamBy does the rest, in your databases (PostgreSQL and
MongoDB) and your storage:

- **Projects and their members**: roles, teams and per-project permissions; invitations and
  requests to join; archiving; exploring public projects.
- **Assets**: uploads by signed URL to S3 (the host's storage, or a project's own), folders,
  versions, metadata, license metadata and credits sheets, reviews with approvals.
- **Processing**: external workers that process assets (the host's or a project's), their jobs
  kept and retried; results kept as new assets or versions. StreamBy orchestrates, versions and
  publishes: it never processes an asset on the server it's mounted in.
- **The workflow**: a canvas that defines the project (its databases, APIs, storages, services,
  exports and pipelines), gates that hold deliverables back, and pipelines whose steps are done
  by people and by workers.
- **Production**: a board of sequences and shots (cards with keys like `WOG-12`), tasks, columns,
  templates and cards made in bulk; deliverables for shots and exports.
- **Documents**: a project's documents with their versions, published to its exports.
- **Exports**: public or private endpoints that serve a project's data and documents.
- **Agents**: API tokens, OAuth for apps the user signs in to (Claude), and an MCP server.

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
distribution connections and project workers' credentials) are encrypted with the key you pass as `encrypt`:
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
| Project | `project:read`, `project:update`, `project:delete` | The project, its settings and its connections (API, database, storage, distribution, workers), integrations and allowed origins. |
| Members | `members:read`, `members:manage` | Listing members and teams; inviting, changing and removing members, searching users, and making, changing and deleting teams. |
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
| `get_workflow`, `list_pipelines`, `get_pipeline`, `list_pipeline_runs` | `workflow:read` |
| `create_pipeline`, `update_pipeline` | `workflow:write` |
| `list_exports` | `project:read` and `exports:read` |
| `get_export` | `exports:read` |
| `get_job`, `list_jobs` | `jobs:read` |
| `list_workers` | `project:read` |
| `process_asset`, `retry_job`, `start_pipeline_run` | `jobs:run` |
| `list_teams` | `members:read` |
| `list_board_columns`, `list_sequences`, `list_shots`, `search_shots`, `list_tasks`, `get_shot_pipeline_runs`, `list_task_templates` | `production:read` |
| `update_sequence`, `update_shot`, `update_task` | `production:write` |
| `create_sequence`, `create_shot`, `create_shots`, `create_task`, `create_task_template`, `update_task_template`, `apply_task_template` | `production:write` |
| `delete_sequence`, `delete_shot`, `delete_task`, `delete_task_template` | `production:delete` |
| `list_asset_versions`, `get_asset_download_url`, `list_deliverables` | `assets:read` |
| `request_asset_upload` (with license metadata, also `rights:write`), `mark_deliverable`, `remove_deliverable` | `assets:write` |
| `list_documents`, `get_document`, `list_document_versions` | `docs:read` |
| `create_document`, `update_document`, `update_document_section`, `move_document` | `docs:write` |
| `delete_document` | `docs:delete` |

An app connected with OAuth and approved to write is also listed the tools of what a project may
let its apps do (deleting a document or an asset, say: see [Project roles](#-project-roles)). A
call to one in a project that doesn't is refused (403).

Each tool's description says where its result shows in the UI. Production data isn't part of
the workflow: `create_sequence`, `create_shot` and `create_task` leave it as it is, and what
they make shows in the Production section of the project's dashboard.

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

**What a list of files downloads.** A list's URLs are signed as of the start of the hour, valid
an hour longer than asked, and ask the storage to answer `Cache-Control: private, max-age=3600`:
every list read in the same hour gets the same URLs, so a browser shows the files it already
downloaded without downloading them again. Each file also has a `thumbnailUrl`, `null` for now:
StreamBy makes no thumbnails (a worker's, asked for with `POST .../jobs/process`, is an image
asset of its own, derived from the file).

A **deliverable** is an asset, or one of its versions, delivered for a
production shot or for an export; a shot or an export can have several, and the shot's panel
in the UI shows them.

**Gates.** A deliverable can wait on gates before it's out. In the project's workflow, a
Deliverable node (`deliverableNode`) stands for the deliverables it applies to, by its
`data.appliesTo`: `'all'` (the default), `'shots'`, or `'exports'` (with `data.exportId`, one
export's only). The gates it has before it (any node with edges leading, step by step, to it)
hold them back until each one passes:

| Gate | Passes when |
|---|---|
| Review Gate (`reviewGateNode`, `data.reviewId`) | the review session it's linked to is approved |
| Credits sheet (`creditsSheetNode`, `data.documentId`) | its sheet is complete: each asset has its creator, link and license |

Each deliverable is answered with its `status`, `'ready'` or `'blocked'`; `gated` (whether
any gate is before it at all); and `blockedBy`, each gate that holds it (`nodeId`, `type`,
`label`) and what it lacks (`reason`). One that no Deliverable node applies to, or whose nodes
have no gates before them, is ready, as it always was. While it's blocked:

- the workers with an `autoKind` don't run on it: they start once it's ready, in the request
  that made it ready and as whoever made it (a session, or an API token with `jobs:run`);
- its export can't be published (`POST /projects/:projectId/deliverables/:exportId/publish`
  answers 409 with `blockedBy`).

Publishing an export (`{ targets: [{ connectionId, channel? }] }`, each one of the project's
distribution connections) records when, by whom and where to: `publishedAt`, `publishedBy` and
`deliverableTargets`. It's only a record: StreamBy uploads nothing to a platform.

If the change that made it ready came from someone who can't run jobs (an API token without
`jobs:run`), its workers stay held: the deliverable is answered with `workersWaiting: true`, and
`POST /projects/:projectId/deliverables/:deliverableId/start-workers` (`jobs:run`, and being able
to edit the project) starts them as the caller, answering the deliverable and the `jobs` started.
A blocked one answers 409 with `blockedBy`; one not held (started already) answers no jobs. Of
two starts, or a start and a gate change, at once, only one starts them. From the MCP server,
`start_deliverable_workers`.

`GET /projects/:projectId/deliverables/gates` answers the state of each Deliverable node of the
workflow (`nodes`, by node id). When something a gate reads changes (a review decided, an
asset's credits, a credits sheet, a file deleted, the workflow saved), each member gets a
`deliverableGatesEvent` (`{ projectId }`) to read the states again.

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

Editors and admins create, edit, publish and delete them; viewers read them (a project may keep
publishing or deleting for its admins). An app connected with OAuth reads and edits them, but
publishes and deletes none, unless its project lets its apps: what it edits stays a draft.

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

StreamBy processes assets only through **external workers**: services it sends a job to, which
download the asset, do their work and upload what they made, kept as a new asset or as the
asset's new version. StreamBy orchestrates (sends, retries, times out), versions and publishes;
it never processes an asset on the server it's mounted in, so the host's API needs no FFmpeg,
no 3D toolkit, and no more memory than its requests. There's one way to ask for any job
(`POST .../jobs/process`), and one contract (below).

**What StreamBy processes, and what it doesn't**

| Processing | Done by | With |
|---|---|---|
| Anything done to an asset's content (thumbnails, transcoding, LODs, glTF optimization or conversion, transcripts, rendering, upscaling...) | a worker of the host or of the project, or a runner shared with it | its own tools |
| Ingest: an uploaded file's metadata (its codec, from its content type) and its first version (`POST .../jobs/ingest`) | StreamBy | nothing external |
| QC reports (`.../assets/:assetId/qc-report`) | whoever posts one | a record of the checks given |
| Publishing an export | nobody | a record of when, by whom and where to (see Deliverables) |

A worker's result may be of another category than its asset (a video's thumbnail is an image, a
transcode to an audio format an audio): it gives that category when asking where to upload it
(`/upload-url`), and it's kept as a new asset derived from it (`resultMode: 'version'` is
refused for it).

**Where workers come from**

- **The host's**, offered to every project, in the router config (each one gated, like the other
  built-ins, by `canUseBuiltin` with kind `'worker'`):

  ```ts
  createStreamByRouter({
    // ...
    workers: [{
      id: 'gltf', name: 'glTF optimizer',
      endpoint: 'https://worker.example.com/jobs', credential: process.env.GLTF_WORKER_TOKEN,
      kinds: ['gltf-optimize'],          // what it does
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
  `DELETE /projects/:projectId/workers`; render farms are connected as workers). Its endpoint
  must be https and never reach a local or private address: not as written, nor as its name
  resolves, which is checked when it's connected and again right before each job is sent (a
  name can point at the server's own network, or start pointing there later). A job for one
  that resolves to such an address fails for good. `workerOptions.allowLocalEndpoints` lifts
  all this, for development. Its credential is stored encrypted, and used only while whoever
  connected it is still in the project.

  The host's own workers aren't checked this way: the host chose them, and they may well be on
  its private network.

- **A runner**: a machine with no public URL (a user's own, behind a router, or one in the
  cloud) that connects to StreamBy and asks for jobs, as self-hosted CI runners do (see Runners,
  below). Its owner shares it with a project or a team.

`GET /projects/:projectId/workers` lists the workers a member can use (a runner's with
`online` and `lastSeenAt`).

**Asking for a job**

`POST /projects/:projectId/jobs/process` with
`{ assetId, versionId?, worker: { source: 'builtin' | 'project' | 'runner', id }, kind, profile?, resultMode? }`
(editors and admins; an API token needs `jobs:run`, and the MCP server has `process_asset`).
`resultMode` decides where the result goes:

- `'derived'` (the default): a new asset, linked to the original (`derivedFrom`), which is never
  touched;
- `'version'`: the asset's new version, at its own key, so its URL serves the result; the
  version it replaces is archived, and can still be downloaded.

A worker with an `autoKind` also runs by itself on an asset of its categories when it's marked
as a deliverable (by a session, or by an API token that has `jobs:run`: one without it marks the
deliverable and starts nothing). On a deliverable blocked by a gate, it runs once the
deliverable is ready (see Gates, above). A pipeline's step set to a worker sends it a job too
(see Pipelines).

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
| `/upload-url` | `{ "fileName": "hero.glb", "contentType": "model/gltf-binary", "category"? }` (of the asset's category; a derived result may give another, e.g. `images` for a video's thumbnail) | `{ "url", "method": "PUT", "headers", "expiresAt" }`: upload the result there |
| `/complete` | `{ "report": { … } }` (optional; any JSON object, kept with the result) | the job, completed, with its `result`: `{ assetId, versionId, mode }` |
| `/fail` | `{ "error": "…", "retryable": false }` | the job, failed with its error (sent again if `retryable` and attempts are left) |

A job its worker doesn't complete before its deadline is sent again, up to
`workerOptions.maxAttempts` times; then it fails, with its error, and can be retried.

**Runners: workers that ask for their jobs**

A worker needs a public URL to be sent jobs. A runner doesn't: it connects to StreamBy and asks
for them, so a user's own machine processes their assets. "Runner" names both the machine
registered in StreamBy and the program on it that asks (as in GitHub's and GitLab's self-hosted
runners). Only how it gets a job changes; the rest of the contract (downloading, calling back,
the result) is the same.

1. **Registering it.** Its owner registers it, with a session (`POST /user/runners`
   `{ name }`; no API token reaches these routes): one runner is one machine. The answer has its
   token (`sbr_` and 32 random bytes), shown once: only its hash is kept. The token only asks for
   jobs and hands them in; it acts as nobody. `GET /user/runners` lists the owner's runners
   (`online`, what each declared last, where it's shared); `DELETE /user/runners/:id`
   revokes one: its token stops working, and its queued and running jobs fail.
2. **Sharing it.** Its owner shares it with a project they're an active member of
   (`POST /user/runners/:id/shares` `{ projectId }`), or only with one of its teams
   (`{ projectId, teamId }`); again with the same project, it changes with whom.
   `DELETE /user/runners/:id/shares/:shareId` stops sharing it there. Shared, it's in the
   project's workers: for its editors (a team's: only its members, and the runner's owner), while
   its owner is still an active member. Not shared, it's in no project's, its owner's included.
3. **Asking for jobs.** The runner asks with a long poll:

   ```
   POST /runner/jobs/next
   Authorization: Bearer sbr_…
   { "kinds": ["gltf-optimize", "lod"], "categories": ["3d-models"], "timeoutSeconds": 3600 }
   ```

   It declares, each time, what its machine can do now (e.g. whether it has Blender or FFmpeg);
   `timeoutSeconds` (optional, 60 seconds to a week; default an hour) is how long it may take a
   job. The answer waits up to 25 seconds (`workerOptions.runnerPollWaitMs`) for a job it can do:
   `200 { "job": … }`, the same body a worker is sent (`jobId`, `kind`, `profile`, `asset`,
   `download`, `callback`, `deadline`), or `204` with none; then it asks again. Each poll is its
   heartbeat: it's `online` if it asked in the last minute (a callback about its job counts too).

A job asked of a runner (`worker: { source: 'runner', id }`) isn't sent: it waits for it, offline
or not. The runner is offered for what it declared last, but it's handed a job only if it
declares the job's kind, and its asset's category, when it asks; and only while whoever asked
for the job may still send it that runner (otherwise the job fails, saying why). A runner that
never connected can't be asked anything yet.

A runner that goes away with a job leaves it, when its deadline passes, back in line: it takes it
again when it's back (a new attempt, with a new callback token), up to
`workerOptions.maxAttempts`. A job its runner doesn't take within 24 hours fails, saying so, and
can be retried.

---

## 🎬 Production cards in bulk, and task templates

`POST /projects/:projectId/production/sequences/:seqId/shots/batch` `{ shots: [...], templateId? }`
makes up to 200 cards in a sequence at once, in the order given, each with its key: every row
(the fields one card takes) is checked first, and if one is wrong none is made (a 400 saying which
`row`). Their numbers are taken at once, so the cards of a batch are numbered one after the other.

A project's task templates (`/projects/:projectId/production/task-templates`: list, `POST`
`{ name, tasks }`, `PATCH`, `DELETE`) are a name and its tasks (1 to 50; each a name, or
`{ name, priority, notes }`). A template is applied to cards with
`POST .../task-templates/:templateId/apply` `{ shotIds }`, or to the cards being made with
`templateId` (one card, or a batch): each card gets its own tasks, as if made one by one. Changing
or deleting a template leaves the tasks it made.

---

## 🛤️ Pipelines: steps done by people and by workers

A pipeline's steps are the nodes of its schema, and each card (a production shot) linked to it
(its `pipelineId`) goes through them in a run of its own. A step starts when the steps with
edges into it are done, and it's done when its source says so:

| Node | Done by | Done when |
|---|---|---|
| Meeting (`meetingNode`, `data.documentId`) | its people and teams | its document (the meeting's notes) is published |
| Tasks (`tasksNode`) | its people and teams | the card's tasks linked to it (their `stepId`) are done; with none, the card is |
| Review Gate (`reviewGateNode`) | who reviews | the review session of the run's asset is approved (or the one in `data.reviewId`) |
| Credits sheet (`creditsSheetNode`) | its rule | its sheet is complete |
| Any process node with `data.worker` (`{ source, id }`) and `data.kind` | the worker | its job completes; the run then carries its result (`data.resultMode`, derived by default) |
| Deliverable (`deliverableNode`) | StreamBy | the run's asset (the approved version) is marked as the card's deliverable, or its export's (`data.exportId`) |
| Anything else | nobody | right away |

Who completes a step done by people is in its node's `data.assignedTo` (user ids) and
`data.teamIds`. Statuses are a card's or a task's own (`todo`, `in_progress`, `review`, `done`),
never its column's name.

**Starting a run.** By hand (`POST /projects/:projectId/pipelines/:pipelineId/runs` `{ shotId }`,
`jobs:run`; a 409 with the run when the card has one going), or by the pipeline's `triggers`:
`card_linked` (a card linked to it), `card_done` (a card done), `deliverable_marked` (an asset
marked as a card's deliverable). A pipeline with none, as every one before them, starts nothing by
itself. A trigger starts a run only for a request that may run jobs (`jobs:run`, for its token and
its role), and the run's workers run as whoever started it, while their role lets them.

**Reading them.** `GET /projects/:projectId/pipelines/:pipelineId/runs` (`?shotId=`) and
`GET /projects/:projectId/production/shots/:shot/pipeline-runs` (the card by its id or its key,
e.g. `WOG-12`) answer each run: its `status` (`running`, `completed`, `failed`, `cancelled`), its
card (`id`, `name`, `key`), the steps it's on now (`current`) and every step (`status`: `waiting`,
`active`, `running`, `done` or `failed`; `reason`, what it waits on; `completedBy`). Each change is
sent to the project's members as a `pipelineRunEvent` (`{ projectId, pipelineId, shotId, runId }`).
A card taken out of the pipeline cancels its run; a pipeline or a card deleted takes its runs.

**What a project calls its sequences and shots.** `PUT /projects/:projectId/production/board/labels`
(its admins) `{ sequence, sequences, shot, shots }` (any of them; an empty one is the default
again): a game's may be sets and assets. Only names: `GET .../production/board` answers them
(`labels`) beside its columns and key.

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
| `admin` | Everything an editor can, plus manage the project's members and teams, and delete the project. |

### A project's permissions

Its admins can change that, project by project (the Permissions section of its settings), and
until they do, it's the table above. The server reads it on every request on the project,
whatever made it (a session, an API token, an app), before its route.

- **Roles.** Each action is the editors' and the admins', or the admins' only: changing the
  project's details and settings (`project:update`), managing its teams (`teams:manage`), writing
  and deleting assets, production, the workflow, exports, rights, starting jobs, and writing,
  publishing and deleting documents. Admins can always do all of it, and viewers only read.
  Managing members (who's in, with which role) and deleting the project stay the admins': who
  manages members hands out roles.
- **Teams.** A team can add actions for the editors in it: an admins' only action, say, for the
  editors of the team that does it. A viewer in a team still only reads, and a deleted team (or
  who leaves it) adds nothing any more.
  Who is in a team that grants permissions, and whether it's there at all, is the admins'
  (only an admin grants a permission): someone else who manages teams can make new ones and
  rename any, but can't change that team's members nor delete it (403).
  `GET /projects/:projectId/teams` says it of each team (`grantsPermissions`).
- **Apps.** An app connected with OAuth gets what its scopes grant, in every project: making and
  changing, never deleting nor publishing. A project can add, for the apps acting in it,
  `assets:delete`, `production:delete`, `docs:publish`, `docs:delete` and `members:manage`
  (its teams, for an app). Only for an app approved to write, and never more than its user's
  role in the project lets them do.

| Endpoint | Who |
|---|---|
| `GET /projects/:projectId/permissions` | Any member (and `project:read`): `{ permissions: { roles, teams, apps }, actions, appPermissions }` |
| `PUT /projects/:projectId/permissions` `{ roles?, teams?, apps? }` | Its admins, from a session only: no token nor app can give itself more. |

A project's public exports (`GET /streamby/:projectId/export/:exportName`) are read without a
session. They only run nodes that read data: never a node that uses an account's credential,
nor one that starts a job.

---

## 🗄️ Database Schema Setup

`createStreamByRouter` connects to the `databases` it's given and, at startup, makes (or brings
up to date) the tables and collections it uses, in their own `streamby` schema: it never touches
another schema of yours. Several instances starting at once take turns (a PostgreSQL advisory
lock), so they don't deadlock.

**Queries by what a request needs.** No request reads every project or user: a user's projects
are asked for by their memberships (`project_members("userId")` in PostgreSQL, indexed;
`members.userId` in MongoDB, indexed), exploring by the projects that aren't private, a project by
its id. A SQL project's members are read for all the projects asked for in one query. Users are
searched in the database (`ILIKE` in PostgreSQL, a case-insensitive escaped regular expression in
MongoDB), the first 20 (the users' table is the host's: an index for it, such as a trigram one on
`username`, is the host's to make). Ids are compared as text, whichever type a database keeps them
in. Only startup's passes (re-encrypting credentials, backfilling built-in
connections) read them all, once.

To make the schema yourself, outside the router (in a migration, say), there are the setup
helpers; `reset: true` drops and makes the `streamby` schema again, and is refused in production
unless `allowResetInProd`:

```ts
import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { setupStreambyPg } from 'streamby-core/dist/pg/setup';
import { setupStreambyMongo } from 'streamby-core/dist/mongo/setup';

await setupStreambyPg({ pool: new Pool({ connectionString: process.env.POSTGRES_URI }), schema: 'streamby' });

const client = new MongoClient(process.env.MONGO_URI!);
await client.connect();
await setupStreambyMongo({ client, dbName: 'streamby' });
```

---

## 🧪 Testing

```bash
npm test
```

Tests use [Vitest](https://vitest.dev) and [Supertest](https://www.npmjs.com/package/supertest),
on Node 22 or later. Most run against in-memory databases; the `*.pg.test.ts` ones need a local
PostgreSQL (`postgresql://postgres:postgres@localhost:5432/postgres`; they make, and drop,
databases of their own).

---

## 🗺️ API Endpoints

Every route is under the path the router is mounted at (e.g. `/streamby`). The sections above
describe each area; this is the map.

| Area | Routes |
|---|---|
| Session | `GET /auth`, `GET /user/subscription`, `GET /users/search?q=` |
| Projects | `GET /projects` (`?archived=`), `GET /projects/explore`, `POST /projects/create`, `GET`, `PATCH`, `DELETE /projects/:id`, `GET /projects/:id/preview`, `PATCH /projects/:id/archive` and `/unarchive`, `POST /projects/:id/image`, `GET` and `PATCH /projects/:id/origins`, `GET` and `PUT /projects/:id/permissions`, `GET /projects/:id/dependents/:kind/:resourceId` |
| Members and teams | `GET`, `POST /projects/:id/members`, `PATCH`, `DELETE /projects/:id/members/:userId` (and `/accept`, `/approve`, `/reject`), `POST /projects/:id/request-join`, `GET`, `POST /projects/:id/teams`, `PATCH`, `DELETE /projects/:id/teams/:teamId` |
| Integrations | `GET`, `POST /user/integrations`, `PATCH`, `DELETE /user/integrations/:id` (and `/dependents`), `GET /user/integrations/oauth/:provider/start` and `/callback`; a project's: `GET`, `POST /projects/:id/integrations`, `DELETE /projects/:id/integrations/:integrationId` |
| Connections | `/projects/:id/connections` (APIs), `/projects/:id/connections/db` (databases, their tables and records), `/projects/:id/connections/storage` (storages, their files and folders), `/projects/:projectId/distribution-connections`, `GET /databases`, `GET /storages` |
| Storage and assets | `GET /projects/:projectId/storage/:category` (and `/upload-url`), `GET /projects/:projectId/storage/lasts`, `PATCH`, `DELETE /projects/:projectId/storage/files/:fileId` (and `/replace-url`), `GET /projects/:projectId/assets/:fileId/download-url`, `/metadata`, `/versions`, `GET`, `PUT .../assets/:assetId/rights`, `GET`, `POST .../assets/:assetId/qc-report`, `GET /projects/:projectId/credits-sheets` (and `/:docId`) |
| Processing | `GET /projects/:projectId/workers`, `POST`, `DELETE` (a project's), `POST /projects/:projectId/jobs/process`, `POST /projects/:projectId/jobs/ingest`, `GET /projects/:projectId/jobs`, `GET /jobs/:jobId`, `POST /projects/:projectId/jobs/:jobId/retry`; workers call back at `POST /worker-jobs/:jobId/progress`, `/upload-url`, `/complete`, `/fail`; runners: `GET`, `POST /user/runners`, `DELETE .../:runnerId`, `POST .../:runnerId/shares`, `DELETE .../shares/:shareId`, and they ask at `POST /runner/jobs/next` |
| Reviews | `GET`, `POST /projects/:projectId/reviews`, `GET /projects/:projectId/reviews/:reviewId`, `POST .../decision` |
| Deliverables | `GET`, `POST /projects/:projectId/deliverables`, `DELETE .../:deliverableId`, `POST .../:deliverableId/start-workers`, `GET .../gates`, `POST /projects/:projectId/deliverables/:exportId/publish` |
| Workflow and pipelines | `GET`, `PATCH /projects/:id/workflow`, `GET`, `POST /projects/:projectId/pipelines`, `GET`, `PATCH`, `DELETE .../:pipelineId`, `GET`, `POST .../:pipelineId/runs`, `GET /projects/:projectId/production/shots/:shot/pipeline-runs` |
| Production | `/projects/:projectId/production/board` (its columns, `key`, `labels`), `/sequences`, `/sequences/:seqId/shots` (and `/batch`), `/shots` (`?q=`), `/shots/:shotId`, `/shots/:shotId/tasks`, `/task-templates` (and `/:templateId/apply`) |
| Documents | `GET`, `POST /projects/:projectId/documents`, `GET`, `PATCH`, `DELETE .../:docId`, `PATCH .../:docId/sections`, `POST .../:docId/publish`, `GET .../:docId/versions` (and `/:version`) |
| Exports | `GET`, `POST /projects/:id/exports`, `GET`, `PATCH`, `DELETE /projects/:id/exports/:exportId`; served at `GET /:projectId/export/:exportName` |
| Tokens and agents | `GET`, `POST`, `DELETE /user/api-tokens` and `/projects/:id/api-tokens`, `POST`, `GET`, `DELETE /mcp`, `GET /.well-known/oauth-protected-resource` |
| Notifications | `GET /notifications` (and `/:id`), `PATCH /notifications/:id/read`, `PATCH /notifications/read-all` |

Real-time events (`jobEvent`, `reviewEvent`, `documentEvent`, `assetRightsEvent`,
`deliverableGatesEvent`, `pipelineRunEvent`...) go to each user through the WebSocket server
given as `websocket`.

---

## 🚣 Roadmap

- [ ] Google Cloud Storage, Cloudflare R2 and Azure Blob as storage providers (S3 only today)
- [ ] Streaming (HLS) for videos and audios
- [ ] Uploading to distribution platforms (publishing is a record today)

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

