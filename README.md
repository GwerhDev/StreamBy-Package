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

Agents and services work with StreamBy as a user through API tokens, without the user's
browser session. A user manages their own tokens (`GET`, `POST` and
`DELETE /streamby/user/api-tokens`, only with a session). Each token has:

- **an access level**: `read` (only reads) or `write` (reads and writes);
- **the projects it reaches**: a list of project ids, or `'*'` for every project the user is a
  member of, including ones they join later;
- **an expiry**: 7, 30, 90 or 365 days, or none.

A token is `sbt_` followed by 32 random bytes. It's shown once, when it's made. Only its
SHA-256 hash is stored, with a short prefix to tell it apart.

Requests send it as `Authorization: Bearer sbt_...`. Your `authProvider` resolves it with
`resolveApiToken` and returns its owner, with the token's scope in `apiToken`:

```ts
import { createStreamByRouter, resolveApiToken, API_TOKEN_PREFIX } from 'streamby-core';

createStreamByRouter({
  // ...
  authProvider: async (req) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (bearer?.startsWith(API_TOKEN_PREFIX)) {
      const resolved = await resolveApiToken(bearer); // null once revoked or expired
      if (!resolved) throw new Error('Invalid API token');
      const user = await findUser(resolved.userId);   // your own user lookup
      return { userId: user.id, username: user.username, role: user.role, apiToken: resolved.scope };
    }
    // ...your session-based authentication
  },
});
```

A request made with a token reaches only what the token's scope allows:

- a `read` token can't write;
- a project outside the token's projects answers 404, and the project list shows only the
  token's projects;
- a token can't manage tokens;
- outside a project, a token can only make a few reads (`/auth`, `/projects`, `/jobs/:jobId`,
  `/user/subscription`, `/users/search`).

The owner's role in each project still applies on top of that. A token never does more than
its owner can, and it stops reaching a project as soon as its owner leaves it.

---

## 🤖 MCP server

StreamBy serves an [MCP](https://modelcontextprotocol.io) server at `POST /streamby/mcp`
(Streamable HTTP, stateless). Agents such as Claude Code use it to read and work on StreamBy
projects with an API token (see above). It takes only an API token; a browser session gets 401.

Each tool calls StreamBy's own REST API with the caller's token. So it reaches exactly what the
token's scope and its owner's role in each project allow, and a write is saved just like one
made from the UI, which shows it when it loads the project.

**Tools**

- **Reading**, with any token:
  - `list_projects`, `get_project`;
  - `list_assets` (by category, optionally in one storage connection, and filtered by name),
    `get_asset_metadata`, `get_asset_rights`;
  - `get_workflow`, `list_pipelines`, `get_pipeline`, `list_exports`, `get_export`;
  - `get_job`;
  - `list_sequences`, `list_shots`, `list_tasks`.
- **Writing**, listed only for a `write` token, and allowed only where its owner is an editor or
  an admin:
  - `update_asset_metadata`, `set_asset_rights`;
  - `create_pipeline`, `update_pipeline`;
  - `create_sequence`, `update_sequence`, `create_shot`, `update_shot`, `create_task`,
    `update_task`.

**Limits and audit**

- Each token can make at most 120 requests a minute (a sliding window). Past that, StreamBy
  answers 429 with `Retry-After`. Each instance counts its own requests. Change the limit with
  `mcp.rateLimit`.
- Every tool call is recorded in the `mcp_audit` table, created at startup in the main database.
  Each row has the user, the token's id, the project, the tool, whether it went through, the
  status, the error and the duration. A row never includes the arguments or the token.

```ts
createStreamByRouter({
  // ...
  mcp: {
    rateLimit: { requests: 120, windowMs: 60_000 }, // the default
    // apiBaseUrl: 'http://127.0.0.1:3000/streamby', // where tools reach the REST API;
    //   by default this same process, at the request's local port and mount path
  },
});
```

### Connecting from Claude Code

Make an API token in StreamBy (Settings → Security → Personal API tokens), and keep it in an
environment variable, never in a file:

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
`env`. This file holds it in plain text, so use a token with only the scope you need, and
an expiry:

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

The claude.ai connector needs OAuth, which isn't available yet: it's for API tokens only for now.

---

## 👥 Project roles

What a user can do in a project depends on their role in that project, as an active member
(an invitation counts once it's accepted). It never depends on the platform role your
`authProvider` returns.

| Role | Can |
|---|---|
| `viewer` | See the project and its content, and archive the project in their own list. |
| `editor` | Everything a viewer can, plus change the project: its details, connections, exports, files and folders, workflow, pipelines, production, reviews, rights, and start jobs. |
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

