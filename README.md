# GitHub Project Templates

Reusable GitHub Projects V2 templates for the Alpha-Bet-New org. Define project field schemas once, apply them automatically or manually to any project.

## Automatic Setup (GitHub App)

A GitHub App (`project-setup-bot`) auto-creates a project whenever a new repo is created in the org. It names the project after the repo, links them, creates all fields from the template, and pushes config files to the repo.

See [`app/README.md`](app/README.md) for setup instructions.

## Manual Setup

```bash
# Apply the ai-review template to an existing project
./scripts/setup-project.sh <PROJECT_ID> ai-review

# Save the generated IDs to the target repo
./scripts/setup-project.sh <PROJECT_ID> ai-review --output /path/to/repo/.github/project-fields.json
```

Or use the GitHub Actions workflow: go to the [Actions tab](.github/workflows/setup-project.yml) → "Setup Project" → "Run workflow".

## Available Templates

| Template | Description |
|---|---|
| [`ai-review`](templates/ai-review/) | Multi-model AI review workflow (Claude, Gemini, Codex propose + cross-review) |

## How It Works

### 1. Template Definition

Each template lives in `templates/<name>/` with:
- `fields.json` — Machine-readable field schema (types, options, colors, descriptions)
- `README.md` — Human-readable documentation and usage guide

### 2. Project Setup

`setup-project.sh` reads the template and creates all fields on a GitHub Project via the GraphQL API. It outputs a JSON file mapping field names to their runtime IDs (which are unique per project).

### 3. Runtime IDs

After setup, save the generated `_generated_ids.json` to the target repo's `.github/` directory. AI models and scripts read this file to get the correct field/option IDs when updating the project.

```
target-repo/
└── .github/
    └── project-fields.json   ← generated IDs for this project
```

## Creating a New Template

1. Create `templates/<name>/fields.json` following the schema:

```json
{
  "template": "my-template",
  "description": "What this template is for",
  "fields": [
    {
      "name": "Field Name",
      "type": "SINGLE_SELECT",
      "description": "What this field means",
      "options": [
        { "name": "Option 1", "color": "GREEN", "description": "When to use" }
      ]
    },
    {
      "name": "Score",
      "type": "NUMBER",
      "description": "What this number means"
    }
  ]
}
```

2. Create `templates/<name>/README.md` with human-readable docs.

3. Run `./scripts/setup-project.sh <PROJECT_ID> <name>` to apply it.

### Supported Field Types

| Type | Description |
|---|---|
| `SINGLE_SELECT` | Dropdown with predefined options. Specify `options` array. |
| `NUMBER` | Numeric field. |
| `TEXT` | Free-text field. |

### Builtin Fields

Set `"builtin": true` for fields that GitHub creates automatically (like Status). The script will update their options rather than creating a new field.

## Prerequisites

- [gh CLI](https://cli.github.com/) authenticated with `project` scope
- [jq](https://jqlang.github.io/jq/) for JSON processing
