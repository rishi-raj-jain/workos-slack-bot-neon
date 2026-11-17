import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Declare your Neon services here
  auth: false,
  aiGateway: true,
  functions: {
    workossync: { name: "Mirror WorkOS data into Postgres", source: "./functions/workossync/index.ts", env: { WORKOS_API_KEY: process.env.WORKOS_API_KEY!, WORKOS_WEBHOOK_SECRET: process.env.WORKOS_WEBHOOK_SECRET!, WORKOS_SYNC_STATUS_TOKEN: process.env.WORKOS_SYNC_STATUS_TOKEN! } },
    slackbot: {
      name: "Slack bot: answers from your WorkOS data",
      source: "./functions/slackbot/index.ts",
      env: {
        // Optional so the first deploy can start the sync before these exist. Until they're set, the bot answers 503.
        SLACK_SIGNING_SECRET: { value: process.env.SLACK_SIGNING_SECRET, required: false, onUndefined: "skip" },
        SLACK_BOT_TOKEN: { value: process.env.SLACK_BOT_TOKEN, required: false, onUndefined: "skip" },
        // Read-only role for the agent's SQL, written by npm run db:setup. DATABASE_URL (owner) is injected by Neon for bot state.
        ANALYST_DATABASE_URL: { value: process.env.ANALYST_DATABASE_URL, required: false, onUndefined: "skip" },
        AI_MODEL: { value: process.env.AI_MODEL, required: false, onUndefined: "skip" },
      },
    },
  },
  // Keep the WorkOS mirror current. Child branches inherit these disabled.
  triggers: {
    "workos-tick":            { type: "schedule", function: "workossync", cron: "* * * * *",   functionPath: "/tick" },
    "workos-backfill":        { type: "schedule", function: "workossync", cron: "*/5 * * * *", functionPath: "/backfill" },
    "workos-reconcile":       { type: "schedule", function: "workossync", cron: "30 * * * *",  functionPath: "/reconcile" },
    "workos-reconcile-fresh": { type: "schedule", function: "workossync", cron: "0 3 * * 0",   functionPath: "/reconcile/fresh" },
  },
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});
