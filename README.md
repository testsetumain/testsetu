# TestSetu

TestSetu is a full-stack online test, assessment, result, certificate, and verification platform for Super Admins, Teachers, and Students.

## Stack

- React + TypeScript + Vite frontend
- Node.js API for Render
- Cloudflare Worker/Pages for frontend assets and domain routing
- MongoDB Cluster 1 as the primary database and GridFS file storage
- Optional future MongoDB Cluster 2 as an independent secondary connection
- Secure scrypt password hashing and signed auth tokens
- PDF generation, QR certificate verification, rankings, objections, notifications, and audit logs

No Cloudflare R2, S3, Cellar, or external object storage is used. Uploaded files/images are stored in MongoDB GridFS with metadata in MongoDB collections.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Set `MONGODB_CLUSTER_1_URI` before starting the backend. The app starts the API on `http://localhost:4000` and Vite on `http://localhost:5173`.

On the first run, create the Super Admin from the setup screen. In local development only, the one-time setup token is shown on the setup screen and stored in `.data/setup-token.txt`. In production, set `SETUP_TOKEN` and `AUTH_SECRET` in the environment.

## Useful Scripts

- `npm run dev` - run API and frontend together
- `npm run build` - type-check and build frontend
- `npm start` - serve API and built frontend
- `npm run seed` - seed a Super Admin using `SEED_SUPER_ADMIN_EMAIL` and `SEED_SUPER_ADMIN_PASSWORD`
- `npm run migrate:sqlite-to-mongo` - optional manual migration from the old local SQLite DB into MongoDB Cluster 1

## Render Backend Environment

Set these in Render:

```bash
NODE_ENV=production
PORT=4000
FRONTEND_URL=https://your-cloudflare-domain.com
APP_URL=https://your-cloudflare-domain.com
MONGODB_CLUSTER_1_URI=mongodb+srv://...
MONGODB_CLUSTER_2_URI=
MONGODB_CLUSTER_2_ENABLED=false
AUTH_SECRET=your-long-random-secret
SETUP_TOKEN=your-one-time-setup-token
```

Optional seed-only variables:

```bash
SEED_SUPER_ADMIN_EMAIL=admin@testsetu.local
SEED_SUPER_ADMIN_PASSWORD=change-this-before-production
```

When Cluster 2 is added later:

```bash
MONGODB_CLUSTER_2_URI=mongodb+srv://...
MONGODB_CLUSTER_2_ENABLED=true
```

Cluster 1 and Cluster 2 are independent MongoDB connections. The app does not merge, duplicate, or automatically migrate data between them.

## Cloudflare Frontend Environment

The included Cloudflare Worker serves the built frontend and proxies `/api/*` and `/uploads/*` to the Render backend. Set this in Cloudflare:

```bash
BACKEND_ORIGIN=https://your-render-backend.onrender.com
```

If you deploy only static frontend assets without the Worker proxy, set this public Vite variable instead:

```bash
VITE_API_URL=https://your-render-backend.onrender.com
```

For a future Next.js wrapper, the equivalent variable is:

```bash
NEXT_PUBLIC_API_URL=https://your-render-backend.onrender.com
```

Do not put MongoDB URIs, auth secrets, setup tokens, or private backend credentials in Cloudflare frontend variables. Keep them only in Render.

## Cloudflare Deployment

Build and deploy the frontend/domain Worker:

```bash
npm install
npm run build
npx wrangler login
npx wrangler deploy --dry-run
npx wrangler deploy
```

Before deploy, update `wrangler.toml`:

```toml
[vars]
BACKEND_ORIGIN = "https://your-render-backend.onrender.com"
```

In the Cloudflare dashboard, add your custom domain to the deployed Worker/Pages route. The Worker handles frontend routing and forwards API/upload traffic to Render.

## Infrastructure Status

Only Super Admin users can access:

```text
GET /api/admin/infrastructure/status
```

The Super Admin dashboard shows:

- MongoDB Cluster 1 status, database, latency, collections count, last checked
- MongoDB Cluster 2 status as Not Configured, Connected, or Disconnected
- MongoDB GridFS storage status
- Render backend health, uptime, environment, last checked

No MongoDB connection strings, usernames, passwords, auth secrets, or private credentials are returned.

## Optional SQLite to MongoDB Migration

The application no longer uses SQLite in runtime logic. If you have old local SQLite data, review and run the manual script:

```bash
MONGODB_CLUSTER_1_URI=mongodb+srv://...
npm run migrate:sqlite-to-mongo
```

Optional source override:

```bash
SQLITE_MIGRATION_SOURCE=.data/testsetu.db npm run migrate:sqlite-to-mongo
```

The script upserts old rows into MongoDB and does not delete the SQLite file.

## Deployment Checklist

1. Create MongoDB Cluster 1.
2. Add Render backend env vars.
3. Deploy backend on Render.
4. Create Super Admin.
5. Deploy frontend/domain Worker on Cloudflare.
6. Set Cloudflare `BACKEND_ORIGIN` or static-only `VITE_API_URL`.
7. Test login, teacher approval, uploads, test publish, student attempt, result PDF, certificate PDF.
8. Check Super Admin Infrastructure Status.
