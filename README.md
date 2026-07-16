# Streetwear City API

Backend for [Streetwear City](../streetwarecity), a separate Express/TypeScript/PostgreSQL service the Next.js frontend talks to over REST.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full picture: folder structure, the RBAC model, how the payment-provider swap works, and known gaps. Keep it updated as modules go from scaffolded to implemented.

## Quick start

```bash
cp .env.example .env   # fill in DATABASE_URL and JWT secrets at minimum
npm install
npm run prisma:migrate
npm run seed
npm run dev
```
