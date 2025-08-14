# @streamby/core

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
npm install @streamby/core
```

---

## 🧱 Basic usage

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

[MIT](./LICENSE)

