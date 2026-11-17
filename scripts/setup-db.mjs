// Runs sql/setup.sql against your Neon database and writes ANALYST_DATABASE_URL to .env.local.
// Usage: npm run db:setup   (runs node --env-file=.env.local, so .env.local is loaded first)
//
// It connects as the owner role with the DATABASE_URL_UNPOOLED that `neon deploy` wrote to .env.local,
// generates a password for identity_analyst, and runs the file in one transaction, so a failed run
// creates nothing. The password goes only into .env.local, never to the terminal.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

// Setup runs DDL in one transaction, so use the direct connection rather than the pooler.
const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
	console.error("DATABASE_URL_UNPOOLED isn't set. Run neon deploy --env .env.local first, which writes it to .env.local, then npm run db:setup.");
	process.exit(1);
}
const ownerUrl = new URL(connectionString);
ownerUrl.searchParams.set("sslmode", "verify-full");
const password = randomBytes(24).toString("hex");

const client = new pg.Client({ connectionString: ownerUrl.href });
await client.connect();
try {
	const { rows } = await client.query("SELECT to_regclass('workos.organization_memberships_live') AS ready");
	if (!rows[0].ready) {
		throw new Error("The workos schema doesn't exist yet. Wait for the sync's first backfill (within five minutes of deploying), then run this again.");
	}
	const placeholder = "PASSWORD :'analyst_password'";
	const sql = readFileSync(new URL("../sql/setup.sql", import.meta.url), "utf8");
	if (!sql.includes(placeholder)) throw new Error(`sql/setup.sql must contain ${placeholder}`);
	await client.query("BEGIN");
	await client.query(sql.replace(placeholder, `PASSWORD ${client.escapeLiteral(password)}`));
	await client.query("COMMIT");
} catch (err) {
	await client.query("ROLLBACK").catch(() => {});
	console.error(`Setup failed, nothing was created: ${err.message}`);
	if (err.code === "42P06" || err.code === "42710") console.error("sql/setup.sql has already run on this database.");
	process.exit(1);
} finally {
	await client.end();
}

const analystUrl = new URL(ownerUrl);
analystUrl.username = "identity_analyst";
analystUrl.password = password;
analystUrl.search = new URL(connectionString).search; // keep Neon's sslmode and channel_binding, so psql accepts the URL too

const line = `ANALYST_DATABASE_URL=${analystUrl}`;
const env = existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "";
const existing = /^ANALYST_DATABASE_URL=.*$/m;
writeFileSync(".env.local", existing.test(env) ? env.replace(existing, line) : env + (env && !env.endsWith("\n") ? "\n" : "") + line + "\n");
console.log(`Set up app, slackbot, and identity_analyst on ${analystUrl.host}, and wrote ANALYST_DATABASE_URL to .env.local.`);
