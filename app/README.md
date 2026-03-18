# Project Setup Bot — GitHub App

A GitHub App that automatically creates and configures a GitHub Project whenever a new repo is created in your org.

## What It Does

When a new repo is created:
1. Creates a GitHub Project V2 with the same name as the repo
2. Links the project to the repo
3. Creates all custom fields from the template (default: `ai-review`)
4. Pushes `project-fields.json`, `project-template.json`, and `PROJECT_FIELDS.md` to the repo's `.github/` directory

Forks are skipped.

## Setup (One-Time)

### Step 1: Create a Cloudflare Account

If you don't have one: https://dash.cloudflare.com/sign-up (free tier is fine — 100K requests/day).

### Step 2: Register the GitHub App

1. Go to https://github.com/organizations/Alpha-Bet-New/settings/apps/new (or your org's settings)
2. Fill in:
   - **App name:** `project-setup-bot`
   - **Homepage URL:** `https://github.com/Alpha-Bet-New/github-project-templates`
   - **Webhook URL:** Leave blank for now (you'll fill this in after deploying)
   - **Webhook secret:** Generate a random string (save it — you'll need it later):
     ```bash
     openssl rand -hex 32
     ```
3. **Permissions:**
   - Repository permissions:
     - **Contents:** Read & Write (to push config files)
     - **Metadata:** Read-only (required)
   - Organization permissions:
     - **Projects:** Read & Write (to create projects and fields)
4. **Subscribe to events:**
   - Check **Repository** (this triggers on repo creation)
5. Click **"Create GitHub App"**
6. Note the **App ID** shown on the app's settings page
7. Scroll to **"Private keys"** → Click **"Generate a private key"** → Save the `.pem` file

### Step 3: Deploy the Worker

```bash
cd app

# Install dependencies
npm install

# Set secrets
wrangler secret put APP_ID
# Paste the App ID from Step 2

wrangler secret put PRIVATE_KEY
# Paste the ENTIRE contents of the .pem file (including BEGIN/END lines)

wrangler secret put WEBHOOK_SECRET
# Paste the webhook secret you generated in Step 2

# Deploy
npm run deploy
```

The deploy command will output a URL like `https://project-setup-bot.<your-subdomain>.workers.dev`.

### Step 4: Set the Webhook URL

1. Go back to your GitHub App settings: https://github.com/organizations/Alpha-Bet-New/settings/apps/project-setup-bot
2. Set **Webhook URL** to the Worker URL from Step 3
3. Click **"Save changes"**

### Step 5: Install the App on Your Orgs

1. Go to https://github.com/organizations/Alpha-Bet-New/settings/apps/project-setup-bot/installations
2. Click **"Install"**
3. Choose **"All repositories"** (or select specific ones)
4. Click **"Install"**

Repeat for each org you want to use.

## Configuration

Edit `wrangler.toml` to change defaults:

```toml
[vars]
DEFAULT_TEMPLATE = "ai-review"          # Which template to use
TEMPLATES_REPO = "Alpha-Bet-New/github-project-templates"  # Where templates live
```

## Adding to a New Org

1. Go to the GitHub App's settings → Install
2. Select the new org
3. Choose repositories
4. Done — new repos in that org will auto-get projects

## Local Development

```bash
cd app
npm install
wrangler dev
```

This starts a local server. Use a tool like [smee.io](https://smee.io) to forward GitHub webhooks to your local machine for testing.

## Notes

- The Worker has zero npm dependencies — uses Web Crypto API and fetch built into Cloudflare Workers.
- Processing happens asynchronously via `waitUntil()` — the webhook response is immediate.
- If a repo is empty when created, files are pushed via the Contents API. If it has a default branch, they're pushed via the Git Data API (single atomic commit).
- The template is fetched from the templates repo at runtime, so updating `fields.json` takes effect immediately without redeploying the Worker.
