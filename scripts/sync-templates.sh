#!/usr/bin/env bash
# sync-templates.sh — Sync fields.json to all template projects across orgs
#
# Usage: ./scripts/sync-templates.sh [template-name]
#   template-name  defaults to "ai-review"
#
# Reads config.json for the org→project mapping, then updates each
# template project's fields to match the template definition.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATE_NAME="${1:-ai-review}"
TEMPLATE_FILE="$ROOT_DIR/templates/$TEMPLATE_NAME/fields.json"
CONFIG_FILE="$ROOT_DIR/config.json"

if [ ! -f "$TEMPLATE_FILE" ]; then
  echo "Error: Template '$TEMPLATE_NAME' not found at $TEMPLATE_FILE" >&2
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: config.json not found at $CONFIG_FILE" >&2
  exit 1
fi

echo "Syncing template '$TEMPLATE_NAME' to all template projects..."
echo ""

# Read the org→project mapping
ORGS=$(jq -r '.template_projects | keys[]' "$CONFIG_FILE")

for ORG in $ORGS; do
  PROJECT_ID=$(jq -r ".template_projects[\"$ORG\"]" "$CONFIG_FILE")
  echo "=== $ORG ($PROJECT_ID) ==="

  # Get existing fields on the project
  EXISTING=$(gh api graphql -f query="
    query {
      node(id: \"$PROJECT_ID\") {
        ... on ProjectV2 {
          fields(first: 30) {
            nodes {
              ... on ProjectV2Field { id name dataType }
              ... on ProjectV2SingleSelectField { id name dataType options { id name } }
            }
          }
        }
      }
    }
  " --jq '.data.node.fields.nodes')

  # Process each field in the template
  FIELD_COUNT=$(jq '.fields | length' "$TEMPLATE_FILE")
  SYNCED=0

  for i in $(seq 0 $((FIELD_COUNT - 1))); do
    FIELD_NAME=$(jq -r ".fields[$i].name" "$TEMPLATE_FILE")
    FIELD_TYPE=$(jq -r ".fields[$i].type" "$TEMPLATE_FILE")
    IS_BUILTIN=$(jq -r ".fields[$i].builtin // false" "$TEMPLATE_FILE")
    HAS_OPTIONS=$(jq ".fields[$i].options // [] | length" "$TEMPLATE_FILE")

    # Check if field already exists
    EXISTING_ID=$(echo "$EXISTING" | jq -r ".[] | select(.name == \"$FIELD_NAME\") | .id // empty")

    if [ "$IS_BUILTIN" = "true" ] && [ -n "$EXISTING_ID" ] && [ "$HAS_OPTIONS" -gt 0 ]; then
      # Update builtin field options
      OPTIONS_GQL=$(jq -r "[.fields[$i].options[] | \"{ name: \\\"\" + .name + \"\\\", color: \" + .color + \", description: \\\"\" + (.description // \"\") + \"\\\" }\"] | join(\", \")" "$TEMPLATE_FILE")

      gh api graphql -f query="
        mutation {
          updateProjectV2Field(input: {
            fieldId: \"$EXISTING_ID\"
            singleSelectOptions: [$OPTIONS_GQL]
          }) {
            projectV2Field { ... on ProjectV2SingleSelectField { id } }
          }
        }
      " --silent
      echo "  Updated: $FIELD_NAME (builtin)"
      SYNCED=$((SYNCED + 1))

    elif [ -z "$EXISTING_ID" ] && [ "$IS_BUILTIN" != "true" ]; then
      # Create new field
      if [ "$FIELD_TYPE" = "SINGLE_SELECT" ] && [ "$HAS_OPTIONS" -gt 0 ]; then
        OPTIONS_GQL=$(jq -r "[.fields[$i].options[] | \"{ name: \\\"\" + .name + \"\\\", color: \" + .color + \", description: \\\"\" + (.description // \"\") + \"\\\" }\"] | join(\", \")" "$TEMPLATE_FILE")

        gh api graphql -f query="
          mutation {
            createProjectV2Field(input: {
              projectId: \"$PROJECT_ID\"
              dataType: SINGLE_SELECT
              name: \"$FIELD_NAME\"
              singleSelectOptions: [$OPTIONS_GQL]
            }) {
              projectV2Field { ... on ProjectV2SingleSelectField { id } }
            }
          }
        " --silent
        echo "  Created: $FIELD_NAME (SINGLE_SELECT)"
      else
        gh api graphql -f query="
          mutation {
            createProjectV2Field(input: {
              projectId: \"$PROJECT_ID\"
              dataType: $FIELD_TYPE
              name: \"$FIELD_NAME\"
            }) {
              projectV2Field { ... on ProjectV2Field { id } }
            }
          }
        " --silent
        echo "  Created: $FIELD_NAME ($FIELD_TYPE)"
      fi
      SYNCED=$((SYNCED + 1))

    elif [ -n "$EXISTING_ID" ] && [ "$FIELD_TYPE" = "SINGLE_SELECT" ] && [ "$HAS_OPTIONS" -gt 0 ]; then
      # Update existing custom field options
      OPTIONS_GQL=$(jq -r "[.fields[$i].options[] | \"{ name: \\\"\" + .name + \"\\\", color: \" + .color + \", description: \\\"\" + (.description // \"\") + \"\\\" }\"] | join(\", \")" "$TEMPLATE_FILE")

      gh api graphql -f query="
        mutation {
          updateProjectV2Field(input: {
            fieldId: \"$EXISTING_ID\"
            singleSelectOptions: [$OPTIONS_GQL]
          }) {
            projectV2Field { ... on ProjectV2SingleSelectField { id } }
          }
        }
      " --silent
      echo "  Updated: $FIELD_NAME (options synced)"
      SYNCED=$((SYNCED + 1))

    else
      echo "  Skipped: $FIELD_NAME (already exists, no changes)"
    fi
  done

  echo "  Synced $SYNCED fields for $ORG"
  echo ""
done

echo "Done! All template projects are in sync."
