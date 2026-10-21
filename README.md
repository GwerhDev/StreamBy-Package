# @streamby/core

[![License: AGPL v3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

Middleware framework for building storage-agnostic media APIs.  
Part of the [StreamBy](https://streamby.nhexa.cl) ecosystem by TerminalCore Labs.

---

## 🚀 What is it?

`@streamby/core` is a plug-and-play middleware for Express (or compatible frameworks) that enables file uploads, listings and **multi-project access** over services like:

- ✅ AWS S3
- ✅ Google Cloud Storage (soon)
- ✅ Cloudflare R2 (soon)
- ✅ Local/Personal servers (soon)

It's designed to be installed inside your existing API as a library — **no need to run a separate backend**.

---

## 📦 Installation

```bash
npm install @streamby/core ws
npm install -D @types/ws
```

---

## 🧱 Basic usage

```ts
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createStreamByRouter } from '@streamby/core';

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

`@streamby/core` requires a pre-configured database schema for its internal operations. It does not manage database connections directly; instead, it expects the host application to provide initialized connection instances. This ensures full control and flexibility for the host environment.

The library will only interact with the specified schema and will not touch other schemas in your database. The `reset` option is opt-in and will only drop and recreate the specified `streamby` schema if explicitly set to `true`.

### PostgreSQL Example

```ts
import { Pool } from "pg";
import { setupStreambyPg } from "@streamby/core/pg/setup"; // Adjust path as per your package structure

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Call setupStreambyPg to ensure the schema and tables are created
// reset: false (default) ensures idempotency and no data loss
await setupStreambyPg({ pool, schema: "streamby", reset: false });
```

### MongoDB Example

```ts
import { MongoClient } from "mongodb";
import { setupStreambyMongo } from "@streamby/core/mongo/setup"; // Adjust path as per your package structure

const client = new MongoClient(process.env.MONGO_URL!);

// Connect the MongoDB client
await client.connect();

// Call setupStreambyMongo to ensure collections and indexes are created
await setupStreambyMongo({ client, dbName: "streamby" });
```

```ts
import express from 'express';
import { createStreamByRouter } from '@streamby/core';

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

Here's a summary of the key API endpoints provided by `@streamby/core`:

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

> **Note for consumers:** unlike most installable packages, this one is intentionally AGPL rather than MIT. AGPL's copyleft applies to any project that depends on it -- if you install `@streamby/core`, your own project must also be licensed under AGPL-3.0 (or a compatible copyleft license). Confirm this is acceptable for your use case before adding this dependency.

