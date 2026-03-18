/**
 * GitHub App webhook handler — Cloudflare Worker
 *
 * On repository.created:
 *   1. Creates a GitHub Project V2 with the same name as the repo
 *   2. Links the project to the repo
 *   3. Creates all custom fields from the template
 *   4. Pushes project-fields.json + docs to the repo's .github/ directory
 *
 * Environment variables (set as Cloudflare Worker secrets):
 *   APP_ID            — GitHub App ID
 *   PRIVATE_KEY       — GitHub App private key (PEM format)
 *   WEBHOOK_SECRET    — Webhook secret for signature verification
 *   DEFAULT_TEMPLATE  — Template name (default: "ai-review")
 *   TEMPLATES_REPO    — Owner/repo for templates (default: "Alpha-Bet-New/github-project-templates")
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

    // Only handle repository creation
    if (event !== "repository" || payload.action !== "created") {
      return new Response("Ignored", { status: 200 });
    }

    // Skip forks
    if (payload.repository.fork) {
      return new Response("Skipping fork", { status: 200 });
    }

    // Respond immediately, process asynchronously
    ctx.waitUntil(handleRepoCreated(payload, env));

    return new Response("Accepted", { status: 202 });
  },
};

// ─── Main Handler ────────────────────────────────────────────────────────────

async function handleRepoCreated(payload, env) {
  const repo = payload.repository;
  const org = payload.organization;
  const templateName = env.DEFAULT_TEMPLATE || "ai-review";
  const templatesRepo = env.TEMPLATES_REPO || "Alpha-Bet-New/github-project-templates";

  console.log(`New repo: ${repo.full_name} — setting up project...`);

  try {
    // 1. Authenticate as the GitHub App installation
    const installationId = payload.installation.id;
    const token = await getInstallationToken(env.APP_ID, env.PRIVATE_KEY, installationId);

    // 2. Fetch the template from the templates repo
    const template = await fetchTemplate(token, templatesRepo, templateName);
    if (!template) {
      console.error(`Template '${templateName}' not found in ${templatesRepo}`);
      return;
    }

    // 3. Get the org's node ID
    const orgId = await getOrgNodeId(token, org.login);

    // 4. Create the project
    const projectId = await createProject(token, orgId, repo.name);
    console.log(`Created project: ${projectId}`);

    // 5. Link project to the repo
    const repoNodeId = repo.node_id;
    await linkProjectToRepo(token, projectId, repoNodeId);
    console.log(`Linked project to ${repo.full_name}`);

    // 6. Create all custom fields from the template
    const generatedFields = await createFields(token, projectId, template);
    console.log(`Created ${Object.keys(generatedFields).length} fields`);

    // 7. Build the generated IDs JSON
    const projectTitle = repo.name;
    const generatedIds = {
      project_id: projectId,
      project_title: projectTitle,
      template: templateName,
      fields: generatedFields,
    };

    // 8. Fetch the template README for docs
    const templateReadme = await fetchTemplateFile(token, templatesRepo, templateName, "README.md");
    const templateFieldsJson = JSON.stringify(template, null, 2);

    // 9. Push config files to the new repo
    await pushConfigFiles(token, repo.full_name, repo.default_branch, {
      ".github/project-fields.json": JSON.stringify(generatedIds, null, 2),
      ".github/project-template.json": templateFieldsJson,
      ".github/PROJECT_FIELDS.md": templateReadme || `# ${projectTitle} — Project Fields\n\nSee project-fields.json for field IDs.\n`,
    });
    console.log(`Pushed config files to ${repo.full_name}/.github/`);

    console.log(`Setup complete for ${repo.full_name}!`);
  } catch (err) {
    console.error(`Failed to set up project for ${repo.full_name}:`, err);
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
