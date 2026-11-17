-- Database setup for the WorkOS Slack bot.
--
-- Run it once with psql, after the first deploy has created the workos schema (within five minutes):
--
--   export ANALYST_PASSWORD=$(openssl rand -hex 24)
--   psql "$(neon connection-string)" -v ON_ERROR_STOP=1 -1 -v analyst_password="$ANALYST_PASSWORD" -f sql/setup.sql
--
-- psql fills in :'analyst_password', so no password is stored in this file.
-- -1 runs the file in one transaction: if any statement fails, nothing is created.

-- Product data, linked to WorkOS organizations -------------------------------

CREATE SCHEMA app;

CREATE TABLE app.accounts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            text NOT NULL,
  domain          text NOT NULL UNIQUE,
  plan            text NOT NULL CHECK (plan IN ('free', 'team', 'enterprise')),
  seats_purchased int  NOT NULL DEFAULT 0,
  mrr_usd         int  NOT NULL DEFAULT 0,
  renewal_date    date,
  account_owner   text,
  workos_org_id   text UNIQUE
);

CREATE TABLE app.usage_daily (
  account_id   bigint NOT NULL REFERENCES app.accounts(id),
  day          date   NOT NULL,
  active_users int    NOT NULL,
  PRIMARY KEY (account_id, day)
);

-- Read-only role for the agent's SQL ------------------------------------------

CREATE ROLE identity_analyst LOGIN PASSWORD :'analyst_password';
ALTER ROLE identity_analyst SET default_transaction_read_only = on;
ALTER ROLE identity_analyst SET statement_timeout = '10s';

GRANT USAGE ON SCHEMA app, workos TO identity_analyst;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO identity_analyst;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO identity_analyst;
GRANT SELECT ON workos.users_live, workos.organizations_live, workos.organization_memberships_live,
  workos.invitations_live, workos.sessions_live, workos.connections_live TO identity_analyst;
GRANT SELECT ON workos.auth_attempts TO identity_analyst;

-- The bot's own state, which identity_analyst can't read ----------------------

CREATE SCHEMA slackbot;
CREATE TABLE slackbot.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, slack_user_id text NOT NULL, slack_channel_id text NOT NULL,
  question text NOT NULL, sql text, row_count int, model text, error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE slackbot.threads (
  channel_id text, thread_ts text, messages jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, thread_ts)
);
CREATE TABLE slackbot.processed_events (event_id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE slackbot.allowed_channels (channel_id text PRIMARY KEY, purpose text);

-- Comments the agent reads with the schema ------------------------------------

COMMENT ON COLUMN workos.organization_memberships_live.role_slug IS 'Role in the organization: ''admin'' or ''member''.';
COMMENT ON COLUMN workos.organization_memberships_live.organization_name IS
  'Often NULL in the mirror. Join workos.organizations_live to get the organization name.';
COMMENT ON COLUMN workos.auth_attempts.ip_address IS 'IP address the sign-in attempt came from.';
COMMENT ON COLUMN workos.organization_memberships_live.status IS 'active, inactive, or pending. Count only active memberships as seats.';
COMMENT ON COLUMN workos.users_live.last_sign_in_at IS
  'Lags: sign-ins emit no user.updated event, so it refreshes at the hourly reconcile. Use workos.auth_attempts for recent sign-ins.';
COMMENT ON TABLE workos.auth_attempts IS 'Every sign-in attempt, successful or failed. Append-only, with no _live view.';
COMMENT ON COLUMN workos.auth_attempts.status IS 'succeeded or failed.';
COMMENT ON COLUMN workos.auth_attempts.user_id IS 'NULL when the email does not belong to any user.';
COMMENT ON COLUMN app.accounts.workos_org_id IS 'Links to workos.organizations_live.id.';
COMMENT ON COLUMN app.accounts.renewal_date IS 'Next contract renewal date. NULL for free accounts.';

-- Business terms the agent reads with the schema -------------------------------

CREATE TABLE app.identity_glossary (term text PRIMARY KEY, definition text NOT NULL, example_sql text);

INSERT INTO app.identity_glossary (term, definition) VALUES
  ('usage drop', 'Average daily active users in the last 30 days versus the 30 days before. A decline of more than 25% is significant.'),
  ('renewal risk', 'A paying account renewing within 60 days whose seat utilization is below 25% or that has a usage drop.'),
  ('failed sign-in spike', '5 or more failed attempts for one email, or from one IP address, within 24 hours.'),
  ('last sign-in', 'The later of users_live.last_sign_in_at and the newest succeeded row in workos.auth_attempts.'),
  ('seat utilization', 'Active memberships in the WorkOS organization divided by app.accounts.seats_purchased.'),
  ('over seat limit', 'Active WorkOS memberships greater than app.accounts.seats_purchased. An upsell signal.'),
  ('expansion candidate', 'An account over its seat limit, or a free or team account whose average daily active users grew more than 50% versus the 30 days before.'),
  ('stale admin', 'An admin whose last sign-in is more than 90 days ago, or who has never signed in.'),
  ('credential stuffing', 'Many failed sign-ins from one IP address across several accounts.'),
  ('cross-customer user', 'A user with active memberships in more than one organization, such as a contractor. Review them when they are an admin anywhere.'),
  ('enterprise customer', 'An account on the enterprise plan (app.accounts.plan = ''enterprise'').'),
  ('admin', 'An active organization membership whose role_slug is ''admin''.'),
  ('live rows', 'Always query the workos *_live views, never the base tables. Base tables include deleted objects.'),
  ('environment join rule', 'Every join between workos tables must also match on _env.');
