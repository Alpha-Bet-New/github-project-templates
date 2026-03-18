/**
 * GitHub App webhook handler — Cloudflare Worker
 *
 * On repository.created:
 *   1. Copies a GitHub Project V2 from a template project (same org), OR
 *      creates a new project + fields from JSON template (cross-org fallback)
 *   2. Links the project to the repo
 *   3. Pushes project-fields.json + docs to the repo's .github/ directory
 *
 * On projects_v2.created (manual project creation):
 *   Applies template fields to the new project (skips if already set up)
 *
 * On projects_v2_item.created (item added to project):
 *   Sets default Status to "Proposed" (per template rules) if no status is set
 *
 * On issue_comment.created (comment with AI signature):
 *   Parses "🤖 **Model** · Verdict" signature → updates reviewer field on project
 *
 * On push to templates repo (fields.json changed):
 *   Syncs all template projects across orgs to match the updated fields.json
 *
 * Environment variables (set as Cloudflare Worker secrets):
 *   APP_ID              — GitHub App ID
 *   PRIVATE_KEY         — GitHub App private key (PEM format)
 *   WEBHOOK_SECRET      — Webhook secret for signature verification
 *   DEFAULT_TEMPLATE    — Template name (default: "ai-review")
 *   TEMPLATES_REPO      — Owner/repo for templates (default: "Alpha-Bet-New/github-project-templates")
 *   TEMPLATE_PROJECTS    — JSON map of org login → template project node ID (e.g. '{"Org1":"PVT_...","Org2":"PVT_..."}')
 */

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";

// ─── Webhook Entry Point ─────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.text();

    // Verify webhook signature
    const signature = request.headers.get("x-hub-signature-256");
    if (!signature) {
      return new Response("Missing signature", { status: 401 });
    }

    const valid = await verifySignature(body, signature, env.WEBHOOK_SECRET);
    if (!valid) {
      return new Response("Invalid signature", { status: 401 });
    }

    const event = request.headers.get("x-github-event");
    const payload = JSON.parse(body);

    const templatesRepo = (env.TEMPLATES_REPO || "Alpha-Bet-New/github-project-templates").toLowerCase();

    if (event === "repository" && payload.action === "created" && !payload.repository.fork) {
      // New repo → set up project
      ctx.waitUntil(handleRepoCreated(payload, env));
      return new Response("Accepted", { status: 202 });
    }

    if (event === "projects_v2" && payload.action === "created") {
      // Manually created project → apply template fields
      ctx.waitUntil(handleProjectCreated(payload, env));
      return new Response("Accepted", { status: 202 });
    }

    if (event === "projects_v2_item" && payload.action === "created") {
      // Item added to project → apply default field values
      ctx.waitUntil(handleItemAdded(payload, env));
      return new Response("Accepted", { status: 202 });
    }

    if (event === "issue_comment" && payload.action === "created") {
      // Comment on issue → check for AI review signature
      ctx.waitUntil(handleIssueComment(payload, env));
      return new Response("Accepted", { status: 202 });
    }

    if (event === "push" && payload.repository.full_name.toLowerCase() === templatesRepo && payload.ref === "refs/heads/main") {
      // Push to templates repo main branch — check if fields.json changed
      const changed = (payload.commits || []).some((c) =>
        [...(c.added || []), ...(c.modified || [])].some((f) => f.match(/^templates\/.*\/fields\.json$/))
      );
      if (changed) {
        ctx.waitUntil(handleTemplateSyncPush(payload, env));
        return new Response("Syncing templates", { status: 202 });
      }
    }

    return new Response("Ignored", { status: 200 });
  },
};

// ─── Main Handler ────────────────────────────────────────────────────────────

async function handleRepoCreated(payload, env) {
  const repo = payload.repository;
  const org = payload.organization;
  const templateName = env.DEFAULT_TEMPLATE || "ai-review";
  const templatesRepo = env.TEMPLATES_REPO || "Alpha-Bet-New/github-project-templates";
  // Per-org template project map: { "OrgLogin": "PVT_..." }
  const templateProjects = JSON.parse(env.TEMPLATE_PROJECTS || "{}");
  const templateProjectId = templateProjects[org.login] || "";

  console.log(`New repo: ${repo.full_name} — setting up project...`);

  try {
    // 1. Authenticate as the GitHub App installation
    const installationId = payload.installation.id;
    const token = await getInstallationToken(env.APP_ID, env.PRIVATE_KEY, installationId);

    const orgId = await getOrgNodeId(token, org.login);
    const repoNodeId = repo.node_id;
    let projectId;
    let generatedFields;

    // 2. Try to copy from the org's template project
    if (templateProjectId) {
      // Copy the template project — inherits all fields, views, and settings
      projectId = await copyProject(token, templateProjectId, orgId, repo.name);
      console.log(`Copied template project → ${projectId}`);

      // Link project to the repo
      await linkProjectToRepo(token, projectId, repoNodeId);
      console.log(`Linked project to ${repo.full_name}`);

      // Query the copied project's fields to build the generated IDs
      generatedFields = await queryProjectFields(token, projectId);
      console.log(`Mapped ${Object.keys(generatedFields).length} fields from copied project`);
    } else {
      // Cross-org fallback: create project + fields from JSON template
      console.log(`Cross-org or no template project — creating fields from JSON...`);

      const template = await fetchTemplate(token, templatesRepo, templateName);
      if (!template) {
        console.error(`Template '${templateName}' not found in ${templatesRepo}`);
        return;
      }

      projectId = await createProject(token, orgId, repo.name);
      console.log(`Created project: ${projectId}`);

      await linkProjectToRepo(token, projectId, repoNodeId);
      console.log(`Linked project to ${repo.full_name}`);

      generatedFields = await createFields(token, projectId, template);
      console.log(`Created ${Object.keys(generatedFields).length} fields`);
    }

    // 3. Build the generated IDs JSON
    const generatedIds = {
      project_id: projectId,
      project_title: repo.name,
      template: templateName,
      fields: generatedFields,
    };

    // 4. Fetch the template README for docs
    const templateReadme = await fetchTemplateFile(token, templatesRepo, templateName, "README.md");
    const templateFieldsJson = await fetchTemplateFile(token, templatesRepo, templateName, "fields.json");

    // 5. Push config files to the new repo
    await pushConfigFiles(token, repo.full_name, repo.default_branch, {
      ".github/project-fields.json": JSON.stringify(generatedIds, null, 2),
      ".github/project-template.json": templateFieldsJson || "{}",
      ".github/PROJECT_FIELDS.md": templateReadme || `# ${repo.name} — Project Fields\n\nSee project-fields.json for field IDs.\n`,
    });
    console.log(`Pushed config files to ${repo.full_name}/.github/`);

    console.log(`Setup complete for ${repo.full_name}!`);
  } catch (err) {
    console.error(`Failed to set up project for ${repo.full_name}:`, err);
  }
}

// ─── Issue Comment Handler ───────────────────────────────────────────────────

// Signature format (at end of comment):
//   ---
//   🤖 **Claude** · Agreed
//
// Model must be: Claude, Gemini, or Codex
// Verdict must be: Agreed, Mostly Agreed, or Disagree

const SIGNATURE_REGEX = /🤖\s*\*{0,2}(Claude|Gemini|Codex)\*{0,2}\s*·\s*(Agreed|Mostly Agreed|Disagree)/i;

async function handleIssueComment(payload, env) {
  const comment = payload.comment;
  const issue = payload.issue;
  const repo = payload.repository;

  // Parse signature from comment body
  const match = comment.body.match(SIGNATURE_REGEX);
  if (!match) return; // No AI signature, ignore

  const modelName = match[1]; // Claude, Gemini, or Codex
  const verdict = match[2];   // Agreed, Mostly Agreed, or Disagree

  // Normalize model name (capitalize first letter)
  const model = modelName.charAt(0).toUpperCase() + modelName.slice(1).toLowerCase();
  const reviewerField = `${model} Reviewer`;

  console.log(`AI review: ${model} → ${verdict} on ${repo.full_name}#${issue.number}`);

  try {
    const installationId = payload.installation.id;
    const token = await getInstallationToken(env.APP_ID, env.PRIVATE_KEY, installationId);

    // Find the issue's project item(s)
    const issueNodeId = issue.node_id;
    const projectItems = await graphql(
      token,
      `query($id: ID!) {
        node(id: $id) {
          ... on Issue {
            projectItems(first: 10) {
              nodes {
                id
                project { id }
              }
            }
          }
        }
      }`,
      { id: issueNodeId }
    );

    const items = projectItems.node?.projectItems?.nodes || [];
    if (items.length === 0) {
      console.log(`Issue #${issue.number} is not in any project, skipping`);
      return;
    }

    for (const item of items) {
      const projectId = item.project.id;
      const itemId = item.id;

      // Get the reviewer field and find the matching option
      const fields = await getExistingFields(token, projectId);
      const field = fields.find((f) => f.name === reviewerField && f.options);
      if (!field) {
        console.log(`Field '${reviewerField}' not found in project ${projectId}`);
        continue;
      }

      const option = field.options.find((o) => o.name === verdict);
      if (!option) {
        console.log(`Option '${verdict}' not found in field '${reviewerField}'`);
        continue;
      }

      // Update the reviewer field
      await graphql(
        token,
        `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
          }) {
            projectV2Item { id }
          }
        }`,
        { projectId, itemId, fieldId: field.id, optionId: option.id }
      );

      console.log(`Set ${reviewerField} → ${verdict} on item ${itemId}`);
    }
  } catch (err) {
    console.error(`Failed to process review comment on ${repo.full_name}#${issue.number}:`, err);
  }
}

// ─── Item Added Handler ──────────────────────────────────────────────────────

async function handleItemAdded(payload, env) {
  const projectNodeId = payload.projects_v2_item.project_node_id;
  const itemNodeId = payload.projects_v2_item.node_id;
  const templateName = env.DEFAULT_TEMPLATE || "ai-review";
  const templatesRepo = env.TEMPLATES_REPO || "Alpha-Bet-New/github-project-templates";

  const installationId = payload.installation.id;
  const token = await getInstallationToken(env.APP_ID, env.PRIVATE_KEY, installationId);

  try {
    // Fetch the template to get default rules
    const template = await fetchTemplate(token, templatesRepo, templateName);
    if (!template || !template.rules || !template.rules.default_status) return;

    const defaultStatus = template.rules.default_status;

    // Get the project's Status field and find the matching option
    const fields = await getExistingFields(token, projectNodeId);
    const statusField = fields.find((f) => f.name === "Status" && f.options);
    if (!statusField) return;

    const statusOption = statusField.options.find((o) => o.name === defaultStatus);
    if (!statusOption) return;

    // Check if Status is already set on this item
    const itemData = await graphql(
      token,
      `query($itemId: ID!) {
        node(id: $itemId) {
          ... on ProjectV2Item {
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
        }
      }`,
      { itemId: itemNodeId }
    );

    const currentStatus = itemData.node?.fieldValueByName?.name;
    if (currentStatus) return; // Already has a status, don't override

    // Set default status
    await graphql(
      token,
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }) {
          projectV2Item { id }
        }
      }`,
      {
        projectId: projectNodeId,
        itemId: itemNodeId,
        fieldId: statusField.id,
        optionId: statusOption.id,
      }
    );

    console.log(`Set default status '${defaultStatus}' on item ${itemNodeId}`);
  } catch (err) {
    // Don't log errors for items where status is already set or field doesn't exist
    if (!err.message?.includes("could not resolve")) {
      console.error(`Failed to set default status on item ${itemNodeId}:`, err);
    }
  }
}

// ─── Project Created Handler ─────────────────────────────────────────────────

async function handleProjectCreated(payload, env) {
  const projectNodeId = payload.projects_v2.node_id;
  const org = payload.organization;
  const templateProjects = JSON.parse(env.TEMPLATE_PROJECTS || "{}");
  const templateName = env.DEFAULT_TEMPLATE || "ai-review";
  const templatesRepo = env.TEMPLATES_REPO || "Alpha-Bet-New/github-project-templates";

  // Skip if this IS a template project (avoid syncing templates to themselves)
  const templateProjectIds = Object.values(templateProjects);
  if (templateProjectIds.includes(projectNodeId)) {
    console.log(`Skipping template project ${projectNodeId}`);
    return;
  }

  const installationId = payload.installation.id;
  const token = await getInstallationToken(env.APP_ID, env.PRIVATE_KEY, installationId);

  // Check if the project already has custom fields (Worker-created projects will)
  const existingFields = await getExistingFields(token, projectNodeId);
  const customFields = existingFields.filter((f) =>
    f.dataType && !["TITLE", "ASSIGNEES", "LABELS", "LINKED_PULL_REQUESTS",
      "MILESTONE", "REPOSITORY", "REVIEWERS", "PARENT_ISSUE",
      "SUB_ISSUES_PROGRESS", "TRACKS"].includes(f.dataType)
  );

  // If it only has the default Status field (no other custom fields), apply template
  const hasOnlyDefaultStatus = customFields.length <= 1 &&
    customFields.every((f) => f.name === "Status");

  if (!hasOnlyDefaultStatus) {
    console.log(`Project ${projectNodeId} already has custom fields, skipping`);
    return;
  }

  console.log(`New project ${projectNodeId} in ${org.login} — applying template...`);

  try {
    // Fetch and apply the template
    const template = await fetchTemplate(token, templatesRepo, templateName);
    if (!template) {
      console.error(`Template '${templateName}' not found`);
      return;
    }

    await syncFieldsToProject(token, projectNodeId, template);
    console.log(`Applied '${templateName}' template to project ${projectNodeId}`);
  } catch (err) {
    console.error(`Failed to apply template to project ${projectNodeId}:`, err);
  }
}

// ─── Template Sync Handler ───────────────────────────────────────────────────

async function handleTemplateSyncPush(payload, env) {
  const templatesRepo = env.TEMPLATES_REPO || "Alpha-Bet-New/github-project-templates";
  const templateProjects = JSON.parse(env.TEMPLATE_PROJECTS || "{}");

  // Figure out which templates were modified
  const changedTemplates = new Set();
  for (const commit of payload.commits || []) {
    for (const file of [...(commit.added || []), ...(commit.modified || [])]) {
      const match = file.match(/^templates\/([^/]+)\/fields\.json$/);
      if (match) changedTemplates.add(match[1]);
    }
  }

  console.log(`Template sync triggered — changed templates: ${[...changedTemplates].join(", ")}`);

  // Get a token for the templates repo (to fetch fields.json)
  const sourceInstallationId = payload.installation.id;
  const sourceToken = await getInstallationToken(env.APP_ID, env.PRIVATE_KEY, sourceInstallationId);

  // Get all app installations (to find tokens for each org)
  const installations = await listInstallations(env.APP_ID, env.PRIVATE_KEY);

  for (const templateName of changedTemplates) {
    // Fetch the updated template
    const template = await fetchTemplate(sourceToken, templatesRepo, templateName);
    if (!template) {
      console.error(`Could not fetch template '${templateName}' after push`);
      continue;
    }

    // Sync to each org's template project
    for (const [orgLogin, projectId] of Object.entries(templateProjects)) {
      console.log(`Syncing '${templateName}' → ${orgLogin} (${projectId})`);

      try {
        // Get installation token for this org
        const installation = installations.find(
          (i) => i.account.login.toLowerCase() === orgLogin.toLowerCase()
        );
        if (!installation) {
          console.error(`No installation found for org '${orgLogin}', skipping`);
          continue;
        }

        const token = await getInstallationToken(env.APP_ID, env.PRIVATE_KEY, installation.id);

        // Sync fields: update existing, create missing
        await syncFieldsToProject(token, projectId, template);
        console.log(`Synced '${templateName}' to ${orgLogin}`);
      } catch (err) {
        console.error(`Failed to sync '${templateName}' to ${orgLogin}:`, err);
      }
    }
  }

  console.log("Template sync complete!");
}

async function listInstallations(appId, privateKey) {
  const jwt = await createJWT(appId, privateKey);
  const resp = await fetch(`${GITHUB_API}/app/installations`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "project-setup-bot",
    },
  });
  if (!resp.ok) {
    throw new Error(`Failed to list installations: ${resp.status}`);
  }
  return await resp.json();
}

async function syncFieldsToProject(token, projectId, template) {
  const existingFields = await getExistingFields(token, projectId);

  for (const field of template.fields) {
    const existing = existingFields.find((f) => f.name === field.name);

    if (existing && field.options) {
      // Update options on existing field (builtin or custom single-select)
      const optionsGql = field.options
        .map((o) => {
          const desc = o.description || "";
          return `{ name: "${escGql(o.name)}", color: ${o.color}, description: "${escGql(desc)}" }`;
        })
        .join(", ");

      await graphql(
        token,
        `mutation {
          updateProjectV2Field(input: {
            fieldId: "${existing.id}"
            singleSelectOptions: [${optionsGql}]
          }) {
            projectV2Field { ... on ProjectV2SingleSelectField { id } }
          }
        }`
      );
      console.log(`  Updated: ${field.name}`);
    } else if (!existing && !field.builtin) {
      // Create new field
      if (field.type === "SINGLE_SELECT" && field.options) {
        const optionsGql = field.options
          .map((o) => {
            const desc = o.description || "";
            return `{ name: "${escGql(o.name)}", color: ${o.color}, description: "${escGql(desc)}" }`;
          })
          .join(", ");

        await graphql(
          token,
          `mutation {
            createProjectV2Field(input: {
              projectId: "${projectId}"
              dataType: SINGLE_SELECT
              name: "${escGql(field.name)}"
              singleSelectOptions: [${optionsGql}]
            }) {
              projectV2Field { ... on ProjectV2SingleSelectField { id } }
            }
          }`
        );
        console.log(`  Created: ${field.name} (SINGLE_SELECT)`);
      } else if (field.type === "NUMBER" || field.type === "TEXT") {
        await graphql(
          token,
          `mutation {
            createProjectV2Field(input: {
              projectId: "${projectId}"
              dataType: ${field.type}
              name: "${escGql(field.name)}"
            }) {
              projectV2Field { ... on ProjectV2Field { id } }
            }
          }`
        );
        console.log(`  Created: ${field.name} (${field.type})`);
      }
    }
  }
}

// ─── GitHub App Authentication ───────────────────────────────────────────────

/**
 * Wrap a PKCS#1 RSA private key DER in a PKCS#8 envelope.
 * PKCS#8 = SEQUENCE { AlgorithmIdentifier, OCTET STRING(PKCS#1 key) }
 */
function wrapPkcs1ToPkcs8(pkcs1Der) {
  // RSA OID: 1.2.840.113549.1.1.1 + NULL params
  const rsaOid = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);

  // Wrap PKCS#1 key in OCTET STRING
  const octetString = asn1Wrap(0x04, pkcs1Der);

  // Version INTEGER 0
  const version = new Uint8Array([0x02, 0x01, 0x00]);

  // Outer SEQUENCE
  const inner = new Uint8Array(version.length + rsaOid.length + octetString.length);
  inner.set(version, 0);
  inner.set(rsaOid, version.length);
  inner.set(octetString, version.length + rsaOid.length);

  return asn1Wrap(0x30, inner);
}

function asn1Wrap(tag, data) {
  const len = data.length;
  let header;
  if (len < 128) {
    header = new Uint8Array([tag, len]);
  } else if (len < 256) {
    header = new Uint8Array([tag, 0x81, len]);
  } else if (len < 65536) {
    header = new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = new Uint8Array([tag, 0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  }
  const result = new Uint8Array(header.length + data.length);
  result.set(header, 0);
  result.set(data, header.length);
  return result;
}

async function createJWT(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: appId,
  };

  // Parse PEM to DER — GitHub generates PKCS#1 keys, Web Crypto needs PKCS#8
  const pemBody = privateKeyPem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/[\n\r\s]/g, "");
  const pkcs1Der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  // Wrap PKCS#1 in PKCS#8 envelope if needed
  const isPkcs1 = privateKeyPem.includes("BEGIN RSA PRIVATE KEY");
  const der = isPkcs1 ? wrapPkcs1ToPkcs8(pkcs1Der) : pkcs1Der;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const body = btoa(JSON.stringify(payload))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const sigInput = new TextEncoder().encode(`${header}.${body}`);
  const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, sigInput);
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${header}.${body}.${sig}`;
}

async function getInstallationToken(appId, privateKey, installationId) {
  const jwt = await createJWT(appId, privateKey);
  const resp = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "project-setup-bot",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to get installation token: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  return data.token;
}

// ─── Webhook Signature Verification ──────────────────────────────────────────

async function verifySignature(body, signature, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return expected === signature;
}

// ─── GitHub API Helpers ──────────────────────────────────────────────────────

async function graphql(token, query, variables = {}) {
  const resp = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "project-setup-bot",
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await resp.json();
  if (data.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

async function getOrgNodeId(token, orgLogin) {
  const data = await graphql(
    token,
    `query($login: String!) { organization(login: $login) { id } }`,
    { login: orgLogin }
  );
  return data.organization.id;
}

async function createProject(token, ownerId, title) {
  const data = await graphql(
    token,
    `mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id }
      }
    }`,
    { ownerId, title }
  );
  return data.createProjectV2.projectV2.id;
}

async function linkProjectToRepo(token, projectId, repositoryId) {
  await graphql(
    token,
    `mutation($projectId: ID!, $repositoryId: ID!) {
      linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
        repository { id }
      }
    }`,
    { projectId, repositoryId }
  );
}

// ─── Copy Project from Template ──────────────────────────────────────────────

async function copyProject(token, sourceProjectId, ownerId, title) {
  const data = await graphql(
    token,
    `mutation($projectId: ID!, $ownerId: ID!, $title: String!) {
      copyProjectV2(input: { projectId: $projectId, ownerId: $ownerId, title: $title, includeDraftIssues: false }) {
        projectV2 { id }
      }
    }`,
    { projectId: sourceProjectId, ownerId, title }
  );
  return data.copyProjectV2.projectV2.id;
}

async function queryProjectFields(token, projectId) {
  const fields = await getExistingFields(token, projectId);
  const result = {};

  for (const field of fields) {
    // Skip built-in fields that aren't useful (Title, Assignees, Labels, etc.)
    // but include Status and any custom fields
    if (!field.dataType) continue;

    const entry = { id: field.id };
    if (field.options && field.options.length > 0) {
      const optMap = {};
      for (const opt of field.options) {
        optMap[opt.name] = opt.id;
      }
      entry.options = optMap;
    }
    result[field.name] = entry;
  }

  return result;
}

// ─── Field Creation ──────────────────────────────────────────────────────────

async function getExistingFields(token, projectId) {
  const data = await graphql(
    token,
    `query($id: ID!) {
      node(id: $id) {
        ... on ProjectV2 {
          fields(first: 30) {
            nodes {
              ... on ProjectV2Field { id name dataType }
              ... on ProjectV2SingleSelectField { id name dataType options { id name } }
            }
          }
        }
      }
    }`,
    { id: projectId }
  );
  return data.node.fields.nodes;
}

async function createFields(token, projectId, template) {
  const existingFields = await getExistingFields(token, projectId);
  const generated = {};

  for (const field of template.fields) {
    const isBuiltin = field.builtin || false;

    if (isBuiltin) {
      // Find existing builtin field and update options
      const existing = existingFields.find((f) => f.name === field.name);
      if (!existing) {
        console.warn(`Builtin field '${field.name}' not found, skipping`);
        continue;
      }

      if (field.options) {
        const optionsGql = field.options
          .map((o) => {
            const desc = o.description || "";
            return `{ name: "${escGql(o.name)}", color: ${o.color}, description: "${escGql(desc)}" }`;
          })
          .join(", ");

        const data = await graphql(
          token,
          `mutation {
            updateProjectV2Field(input: {
              fieldId: "${existing.id}"
              singleSelectOptions: [${optionsGql}]
            }) {
              projectV2Field {
                ... on ProjectV2SingleSelectField { id options { id name } }
              }
            }
          }`
        );

        const result = data.updateProjectV2Field.projectV2Field;
        const optMap = {};
        for (const opt of result.options) {
          optMap[opt.name] = opt.id;
        }
        generated[field.name] = { id: existing.id, options: optMap };
      }
    } else if (field.type === "SINGLE_SELECT") {
      const optionsGql = field.options
        .map((o) => {
          const desc = o.description || "";
          return `{ name: "${escGql(o.name)}", color: ${o.color}, description: "${escGql(desc)}" }`;
        })
        .join(", ");

      const data = await graphql(
        token,
        `mutation {
          createProjectV2Field(input: {
            projectId: "${projectId}"
            dataType: SINGLE_SELECT
            name: "${escGql(field.name)}"
            singleSelectOptions: [${optionsGql}]
          }) {
            projectV2Field {
              ... on ProjectV2SingleSelectField { id options { id name } }
            }
          }
        }`
      );

      const result = data.createProjectV2Field.projectV2Field;
      const optMap = {};
      for (const opt of result.options) {
        optMap[opt.name] = opt.id;
      }
      generated[field.name] = { id: result.id, options: optMap };
    } else if (field.type === "NUMBER" || field.type === "TEXT") {
      const data = await graphql(
        token,
        `mutation {
          createProjectV2Field(input: {
            projectId: "${projectId}"
            dataType: ${field.type}
            name: "${escGql(field.name)}"
          }) {
            projectV2Field {
              ... on ProjectV2Field { id }
            }
          }
        }`
      );
      generated[field.name] = { id: data.createProjectV2Field.projectV2Field.id };
    }
  }

  return generated;
}

function escGql(str) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ─── Template Fetching ───────────────────────────────────────────────────────

async function fetchTemplate(token, templatesRepo, templateName) {
  const content = await fetchTemplateFile(token, templatesRepo, templateName, "fields.json");
  if (!content) return null;
  return JSON.parse(content);
}

async function fetchTemplateFile(token, templatesRepo, templateName, fileName) {
  const url = `${GITHUB_API}/repos/${templatesRepo}/contents/templates/${templateName}/${fileName}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw+json",
      "User-Agent": "project-setup-bot",
    },
  });
  if (!resp.ok) return null;
  return await resp.text();
}

// ─── Push Files to Repo ──────────────────────────────────────────────────────

async function pushConfigFiles(token, repoFullName, defaultBranch, files) {
  // Get the latest commit SHA on default branch
  const refResp = await fetch(`${GITHUB_API}/repos/${repoFullName}/git/ref/heads/${defaultBranch}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "project-setup-bot",
    },
  });

  if (!refResp.ok) {
    // Repo might be empty — create files via the contents API instead
    for (const [path, content] of Object.entries(files)) {
      await fetch(`${GITHUB_API}/repos/${repoFullName}/contents/${path}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "project-setup-bot",
        },
        body: JSON.stringify({
          message: `Add project config from template\n\nAuto-generated by project-setup-bot.`,
          content: btoa(unescape(encodeURIComponent(content))),
        }),
      });
    }
    return;
  }

  const refData = await refResp.json();
  const latestSha = refData.object.sha;

  // Get the tree
  const commitResp = await fetch(`${GITHUB_API}/repos/${repoFullName}/git/commits/${latestSha}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "project-setup-bot",
    },
  });
  const commitData = await commitResp.json();
  const baseTreeSha = commitData.tree.sha;

  // Create blobs for each file
  const treeItems = [];
  for (const [path, content] of Object.entries(files)) {
    const blobResp = await fetch(`${GITHUB_API}/repos/${repoFullName}/git/blobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "project-setup-bot",
      },
      body: JSON.stringify({ content, encoding: "utf-8" }),
    });
    const blobData = await blobResp.json();
    treeItems.push({
      path,
      mode: "100644",
      type: "blob",
      sha: blobData.sha,
    });
  }

  // Create tree
  const treeResp = await fetch(`${GITHUB_API}/repos/${repoFullName}/git/trees`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "project-setup-bot",
    },
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
  });
  const treeData = await treeResp.json();

  // Create commit
  const newCommitResp = await fetch(`${GITHUB_API}/repos/${repoFullName}/git/commits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "project-setup-bot",
    },
    body: JSON.stringify({
      message: "Add project config from template\n\nAuto-generated by project-setup-bot.",
      tree: treeData.sha,
      parents: [latestSha],
    }),
  });
  const newCommitData = await newCommitResp.json();

  // Update ref
  await fetch(`${GITHUB_API}/repos/${repoFullName}/git/refs/heads/${defaultBranch}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "project-setup-bot",
    },
    body: JSON.stringify({ sha: newCommitData.sha }),
  });
}
