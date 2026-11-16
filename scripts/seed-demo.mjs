// Seed demo data for the WorkOS Slack bot: customers, users, roles, invitations, and real
// sign-in activity in a WorkOS *staging* environment, plus product data in Neon.
//
//   node --env-file=.env.local scripts/seed-demo.mjs                 seed everything
//   node --env-file=.env.local scripts/seed-demo.mjs --signins-only  refresh sign-in activity
//   node --env-file=.env.local scripts/seed-demo.mjs --cleanup       delete the demo data
//
// Needs WORKOS_API_KEY (an sk_test_ key), WORKOS_CLIENT_ID, and DATABASE_URL.
// Run it after the first backfill, so the workos schema exists. Safe to re-run.
import pg from "pg";

const KEY = process.env.WORKOS_API_KEY;
const CLIENT_ID = process.env.WORKOS_CLIENT_ID;
const PREFIX = process.env.DEMO_PREFIX ?? ""; // optional, to keep test runs apart
const args = new Set(process.argv.slice(2));
if (!KEY?.startsWith("sk_test_")) throw new Error("WORKOS_API_KEY must be a staging (sk_test_) key. This script never touches production.");
if (!CLIENT_ID) throw new Error("Set WORKOS_CLIENT_ID (WorkOS dashboard > API keys) to seed sign-ins.");

const PASSWORD = "Demo-Signin-2026!";
const domain = (d) => `${PREFIX}${d}.example`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- The demo dataset ----------

// renew: days from today. usage: how daily active users move in the last 30 days.
const CUSTOMERS = [
	{ key: "acme", name: "Acme Corp", plan: "enterprise", seats: 50, mrr: 4500, renew: 45, owner: "Sofia Martinez", usage: "flat" },
	{ key: "globex", name: "Globex", plan: "enterprise", seats: 120, mrr: 9800, renew: 28, owner: "Sofia Martinez", usage: "flat" },
	{ key: "umbrella", name: "Umbrella Labs", plan: "enterprise", seats: 30, mrr: 2600, renew: 70, owner: "Liam Chen", usage: "drop" },
	{ key: "initech", name: "Initech", plan: "team", seats: 15, mrr: 750, renew: 120, owner: "Liam Chen", usage: "flat" },
	{ key: "hooli", name: "Hooli", plan: "team", seats: 25, mrr: 1200, renew: 18, owner: "Sofia Martinez", usage: "flat" },
	{ key: "piedpiper", name: "Pied Piper", plan: "free", seats: 5, mrr: 0, renew: null, owner: "Liam Chen", usage: "growth" },
	{ key: "kestrel", name: "Kestrel Logistics", plan: "team", seats: 5, mrr: 400, renew: 200, owner: "Liam Chen", usage: "growth" },
];

// signin: "ok" signs in, "never" doesn't, "typo" fails twice first, "locked" only fails, "attacked:N" gets N failures from one IP.
const U = (first, last, org, role, signin = "ok") => ({ first, last, email: `${first}.${last}@${domain(org)}`.toLowerCase(), memberships: [[org, role]], signin });
const USERS = [
	U("Ada", "Park", "acme", "admin"), U("Marco", "Silva", "acme", "admin", "never"), U("Ben", "Ortiz", "acme", "member", "typo"),
	U("Cara", "Singh", "acme", "member"), U("Dev", "Malik", "acme", "member", "never"),
	U("Grace", "Liu", "globex", "admin", "never"), U("Omar", "Haddad", "globex", "admin", "never"), U("Priya", "Nair", "globex", "member", "never"),
	U("Sam", "Weller", "globex", "member", "never"), U("Tess", "Kim", "globex", "member", "never"), U("Jonas", "Berg", "globex", "member", "never"),
	U("Alice", "Moreau", "umbrella", "admin", "attacked:4"), U("Marcus", "Reid", "umbrella", "admin", "attacked:12"),
	U("Nina", "Cho", "umbrella", "member"), U("Leo", "Brandt", "umbrella", "member", "never"),
	U("Helen", "Ford", "initech", "admin"), U("Peter", "Gold", "initech", "member"), U("Joanna", "Diaz", "initech", "member", "never"),
	U("Gina", "Bell", "hooli", "admin"), U("Raj", "Patel", "hooli", "member", "locked"), U("Denise", "Wu", "hooli", "member"),
	U("Rita", "Hayes", "piedpiper", "admin"),
	U("Owen", "Price", "kestrel", "admin"), ...["Maya Ross", "Eli Grant", "Zoe Hart", "Ivan Novak", "Lena Fox", "Tom Reyes"].map((n) => U(...n.split(" "), "kestrel", "member")),
	// A contractor in two customers, and an admin at one of them.
	{ first: "Jordan", last: "Kim", email: `jordan.kim@${domain("contractor")}`, memberships: [["acme", "member"], ["hooli", "admin"]], signin: "ok" },
];
const PROMOTE = `priya.nair@${domain("globex")}`; // member -> admin after joining
const DEACTIVATE = `dev.malik@${domain("acme")}`; // offboarded
const INVITES = [
	{ email: `chris.lane@${domain("acme")}`, org: "acme", role: "member", days: 7 },
	{ email: `it.admin@${domain("umbrella")}`, org: "umbrella", role: "admin", days: 14 },
	{ email: `pat.morgan@${domain("kestrel")}`, org: "kestrel", role: "member", days: 7 },
	{ email: `vendor.access@${domain("globex")}`, org: "globex", role: "member", days: 7, revoke: true },
];
const ATTACKER = { ip: "203.0.113.77", ua: "python-requests/2.32.3", ghost: `admin@${domain("acme")}` };
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";
const officeIp = (org) => `198.51.100.${10 + 10 * CUSTOMERS.findIndex((c) => c.key === org)}`;

// ---------- WorkOS API ----------

async function workos(method, path, body) {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(`https://api.workos.com${path}`, {
			method,
			headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
		if (res.status === 429 && attempt < 5) { await sleep(2000 * (attempt + 1)); continue; }
		const json = await res.json().catch(() => ({}));
		return { status: res.status, json };
	}
}
async function must(method, path, body) {
	const { status, json } = await workos(method, path, body);
	if (status >= 300) throw new Error(`${method} ${path} -> ${status} ${json.code ?? json.error ?? ""} ${json.message ?? ""}`);
	return json;
}

async function findOrCreateOrg(c) {
	const found = await must("GET", `/organizations?domains=${domain(c.key)}`);
	if (found.data?.length) return found.data[0];
	return must("POST", "/organizations", { name: c.name, external_id: domain(c.key), domain_data: [{ domain: domain(c.key), state: "verified" }] });
}

async function findOrCreateUser(u) {
	const found = await must("GET", `/user_management/users?email=${encodeURIComponent(u.email)}`);
	const needsPassword = u.signin !== "never" && u.signin !== "locked";
	const fields = { first_name: u.first, last_name: u.last, email_verified: true, ...(needsPassword ? { password: PASSWORD } : {}) };
	if (found.data?.length) return must("PUT", `/user_management/users/${found.data[0].id}`, fields);
	return must("POST", "/user_management/users", { email: u.email, ...fields });
}

async function ensureMembership(userId, orgId, role) {
	const found = await must("GET", `/user_management/organization_memberships?user_id=${userId}&organization_id=${orgId}&statuses=active&statuses=inactive&statuses=pending`);
	if (found.data?.length) return found.data[0];
	return must("POST", "/user_management/organization_memberships", { user_id: userId, organization_id: orgId, role_slug: role });
}

async function signIn(email, password, ip, ua, orgId) {
	let { status, json } = await workos("POST", "/user_management/authenticate", {
		client_id: CLIENT_ID, client_secret: KEY, grant_type: "password", email, password, ip_address: ip, user_agent: ua,
	});
	// Users in more than one organization pick one.
	if (json.code === "organization_selection_required" && orgId) {
		({ status, json } = await workos("POST", "/user_management/authenticate", {
			client_id: CLIENT_ID, client_secret: KEY, grant_type: "urn:workos:oauth:grant-type:organization-selection",
			pending_authentication_token: json.pending_authentication_token, organization_id: orgId, ip_address: ip, user_agent: ua,
		}));
	}
	await sleep(300);
	return status === 200 ? "ok" : json.code ?? json.error ?? String(status);
}

// ---------- Steps ----------

async function seedSignins(orgIds) {
	const tally = {};
	const note = (what, outcome) => (tally[`${what}: ${outcome}`] = (tally[`${what}: ${outcome}`] ?? 0) + 1);
	for (const u of USERS.filter((u) => u.signin.startsWith("attacked"))) {
		const n = Number(u.signin.split(":")[1]);
		for (let i = 0; i < n; i++) note("credential stuffing", await signIn(u.email, `Summer2026${i}!`, ATTACKER.ip, ATTACKER.ua));
	}
	for (let i = 0; i < 5; i++) note("credential stuffing (no such user)", await signIn(ATTACKER.ghost, `Password${i}!`, ATTACKER.ip, ATTACKER.ua));
	for (const u of USERS) {
		const [org] = u.memberships.at(-1);
		const ip = u.email.includes("contractor") ? "192.0.2.200" : officeIp(org);
		if (u.signin === "typo") for (const pw of ["Demo-Signin-2025!", "demo-signin-2026!"]) note("typo", await signIn(u.email, pw, ip, CHROME));
		if (u.signin === "locked") for (let i = 0; i < 3; i++) note("locked out", await signIn(u.email, `wrong-${i}`, ip, CHROME));
		if (["ok", "typo"].includes(u.signin) || u.signin.startsWith("attacked:12")) note("sign-in", await signIn(u.email, PASSWORD, ip, CHROME, orgIds[org]));
	}
	console.log("sign-ins:", tally);
}

async function seedWorkos() {
	const orgIds = {};
	for (const c of [...CUSTOMERS]) orgIds[c.key] = (await findOrCreateOrg(c)).id;
	console.log(`organizations: ${Object.keys(orgIds).length}`);

	const memberships = {};
	for (const u of USERS) {
		const user = await findOrCreateUser(u);
		for (const [org, role] of u.memberships) memberships[`${u.email}|${org}`] = await ensureMembership(user.id, orgIds[org], role);
	}
	console.log(`users: ${USERS.length}, memberships: ${Object.keys(memberships).length}`);

	const promote = memberships[`${PROMOTE}|globex`];
	if (promote.role?.slug !== "admin") await must("PUT", `/user_management/organization_memberships/${promote.id}`, { role_slug: "admin" });
	const offboard = memberships[`${DEACTIVATE}|acme`];
	if (offboard.status !== "inactive") await must("PUT", `/user_management/organization_memberships/${offboard.id}/deactivate`);

	for (const inv of INVITES) {
		const existing = await must("GET", `/user_management/invitations?organization_id=${orgIds[inv.org]}&email=${encodeURIComponent(inv.email)}`);
		const invitation = existing.data?.[0] ?? (await must("POST", "/user_management/invitations", { email: inv.email, organization_id: orgIds[inv.org], role_slug: inv.role, expires_in_days: inv.days }));
		if (inv.revoke && invitation.state === "pending") await must("POST", `/user_management/invitations/${invitation.id}/revoke`);
	}
	console.log(`invitations: ${INVITES.length} (1 revoked); promoted ${PROMOTE}; deactivated ${DEACTIVATE}`);
	return orgIds;
}

async function seedNeon(orgIds) {
	const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await db.connect();
	await db.query(`
		CREATE SCHEMA IF NOT EXISTS app;
		CREATE TABLE IF NOT EXISTS app.accounts (
			id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, domain text NOT NULL UNIQUE,
			plan text NOT NULL CHECK (plan IN ('free','team','enterprise')), seats_purchased int NOT NULL DEFAULT 0,
			mrr_usd int NOT NULL DEFAULT 0, renewal_date date, account_owner text, workos_org_id text UNIQUE);
		CREATE TABLE IF NOT EXISTS app.usage_daily (
			account_id bigint NOT NULL REFERENCES app.accounts(id), day date NOT NULL,
			active_users int NOT NULL, api_calls int NOT NULL, PRIMARY KEY (account_id, day));
		CREATE TABLE IF NOT EXISTS app.identity_glossary (term text PRIMARY KEY, definition text NOT NULL, example_sql text);`);

	for (const c of CUSTOMERS) {
		const { rows } = await db.query(
			`INSERT INTO app.accounts (name, domain, plan, seats_purchased, mrr_usd, renewal_date, account_owner, workos_org_id)
			 VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE current_date + $6::int END, $7, $8)
			 ON CONFLICT (domain) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan, seats_purchased = EXCLUDED.seats_purchased,
			   mrr_usd = EXCLUDED.mrr_usd, renewal_date = EXCLUDED.renewal_date, account_owner = EXCLUDED.account_owner, workos_org_id = EXCLUDED.workos_org_id
			 RETURNING id`,
			[c.name, domain(c.key), c.plan, c.seats, c.mrr, c.renew, c.owner, orgIds[c.key]],
		);
		// 60 days of usage. The last 30 days drop 60% for "drop" and roughly triple for "growth".
		await db.query("DELETE FROM app.usage_daily WHERE account_id = $1", [rows[0].id]);
		await db.query(
			`INSERT INTO app.usage_daily (account_id, day, active_users, api_calls)
			 SELECT $1, d::date,
			   greatest(1, round(least($2, 30) * (0.35 + 0.25 * random()) * CASE WHEN d > current_date - 30 THEN $3::numeric ELSE 1 END))::int,
			   round(least($2, 30) * (40 + 60 * random()) * CASE WHEN d > current_date - 30 THEN $3::numeric ELSE 1 END)::int
			 FROM generate_series(current_date - 59, current_date, interval '1 day') d`,
			[rows[0].id, c.seats, { flat: 1, drop: 0.4, growth: 3.2 }[c.usage]],
		);
	}

	await db.query(`INSERT INTO app.identity_glossary (term, definition) VALUES
		('enterprise customer', 'An account on the enterprise plan (app.accounts.plan = ''enterprise'').'),
		('admin', 'An active organization membership whose role_slug is ''admin''.'),
		('seat utilization', 'Active memberships in the WorkOS organization divided by app.accounts.seats_purchased.'),
		('last sign-in', 'The later of users_live.last_sign_in_at and the newest succeeded row in workos.auth_attempts. Always use both; last_sign_in_at alone lags.'),
		('stale admin', 'An admin whose last sign-in is more than 90 days ago, or who has never signed in.'),
		('usage drop', 'Average daily active users in app.usage_daily over the last 30 days versus the 30 days before. A decline of more than 25% is significant.'),
		('renewal risk', 'A paying account renewing within 60 days whose seat utilization is below 25% or that has a usage drop.'),
		('over seat limit', 'Active WorkOS memberships greater than app.accounts.seats_purchased. An upsell signal.'),
		('expansion candidate', 'An account over its seat limit, or a free/team account whose average daily active users grew more than 50% versus the 30 days before.'),
		('failed sign-in spike', '5 or more failed attempts in workos.auth_attempts for one email, or from one ip_address, within 24 hours. Many failures from one IP across several accounts suggests credential stuffing.'),
		('cross-customer user', 'A user with active memberships in more than one organization, such as a contractor. Worth reviewing when they are an admin anywhere.'),
		('live rows', 'Always query the workos *_live views, never the base tables; base tables include deleted objects.'),
		('environment join rule', 'Every join between workos tables must also match on _env.')
		ON CONFLICT (term) DO UPDATE SET definition = EXCLUDED.definition`);

	// Comments the agent reads with the schema. They need the workos schema from the first backfill.
	const { rows: [{ ready }] } = await db.query("SELECT to_regclass('workos.organization_memberships_live') IS NOT NULL AS ready");
	if (ready) {
		await db.query(`
			COMMENT ON COLUMN app.accounts.workos_org_id IS 'Links to workos.organizations_live.id.';
			COMMENT ON COLUMN app.accounts.renewal_date IS 'Next contract renewal date. NULL for free accounts.';
			COMMENT ON COLUMN workos.organization_memberships_live.role_slug IS 'Role in the organization: ''admin'' or ''member''.';
			COMMENT ON COLUMN workos.organization_memberships_live.status IS 'active, inactive, or pending. Count only active memberships as seats.';
			COMMENT ON COLUMN workos.organization_memberships_live.organization_name IS 'Often NULL in the mirror. Join workos.organizations_live to get the organization name.';
			COMMENT ON COLUMN workos.users_live.last_sign_in_at IS 'Lags: sign-ins emit no user.updated event, so it refreshes at the hourly reconcile. Use workos.auth_attempts for recent sign-ins.';
			COMMENT ON TABLE workos.auth_attempts IS 'Every sign-in attempt, successful or failed. Append-only, with no _live view.';
			COMMENT ON COLUMN workos.auth_attempts.status IS 'succeeded or failed.';
			COMMENT ON COLUMN workos.auth_attempts.ip_address IS 'IP address the sign-in attempt came from.';
			COMMENT ON COLUMN workos.auth_attempts.user_id IS 'NULL when the email does not belong to any user.';`);
	} else console.warn("The workos schema doesn't exist yet. Re-run after the first backfill to add its comments.");
	await db.end();
	console.log(`neon: ${CUSTOMERS.length} accounts with 60 days of usage, glossary, ${ready ? "and column comments" : "no column comments yet"}`);
}

async function cleanup() {
	// Invitations create a pending user for each invitee, so delete those too.
	for (const u of [...USERS, ...INVITES, { email: ATTACKER.ghost }]) {
		const found = await must("GET", `/user_management/users?email=${encodeURIComponent(u.email)}`);
		for (const user of found.data ?? []) await must("DELETE", `/user_management/users/${user.id}`);
	}
	for (const c of CUSTOMERS) {
		const found = await must("GET", `/organizations?domains=${domain(c.key)}`);
		for (const org of found.data ?? []) await must("DELETE", `/organizations/${org.id}`);
	}
	const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await db.connect();
	const domains = CUSTOMERS.map((c) => domain(c.key));
	await db.query("DELETE FROM app.usage_daily WHERE account_id IN (SELECT id FROM app.accounts WHERE domain = ANY($1))", [domains]);
	await db.query("DELETE FROM app.accounts WHERE domain = ANY($1)", [domains]);
	await db.end();
	console.log("deleted the demo users, organizations, and accounts. The sync removes them from the mirror within a minute.");
}

if (args.has("--cleanup")) await cleanup();
else if (args.has("--signins-only")) {
	const orgIds = {};
	for (const c of CUSTOMERS) orgIds[c.key] = (await findOrCreateOrg(c)).id;
	await seedSignins(orgIds);
} else {
	const orgIds = await seedWorkos();
	if (!args.has("--no-signins")) await seedSignins(orgIds);
	await seedNeon(orgIds);
	console.log("done. Wait about a minute for the sync, then ask the bot a question.");
}
