#!/usr/bin/env bash
#
# setup-project.sh — Apply a template's fields to a GitHub Projects V2 project.
#
# Usage:
#   ./scripts/setup-project.sh <PROJECT_ID> <TEMPLATE_NAME> [--output <path>]
#
# Examples:
#   ./scripts/setup-project.sh PVT_kwDOCx99fM4BSGlz ai-review
#   ./scripts/setup-project.sh PVT_kwDOCx99fM4BSGlz ai-review --output .github/project-fields.json
#
# Prerequisites:
#   - gh CLI authenticated with appropriate scopes (project read/write)
#   - jq installed
#
# What it does:
#   1. Reads the template's fields.json
#   2. For each non-builtin field, creates it on the project via GraphQL
#   3. For builtin fields (Status), updates options to match the template
#   4. Outputs a _generated_ids.json mapping field names to their runtime IDs
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# --- Parse args ---
if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <PROJECT_ID> <TEMPLATE_NAME> [--output <path>]"
    echo ""
    echo "Arguments:"
    echo "  PROJECT_ID     GitHub Projects V2 ID (e.g., PVT_kwDOCx99fM4BSGlz)"
    echo "  TEMPLATE_NAME  Template directory name under templates/ (e.g., ai-review)"
    echo ""
    echo "Options:"
    echo "  --output <path>  Write generated IDs to this path (default: stdout)"
    exit 1
fi

PROJECT_ID="$1"
TEMPLATE_NAME="$2"
OUTPUT_PATH=""

shift 2
while [[ $# -gt 0 ]]; do
    case "$1" in
        --output)
            OUTPUT_PATH="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

TEMPLATE_DIR="$REPO_ROOT/templates/$TEMPLATE_NAME"
FIELDS_JSON="$TEMPLATE_DIR/fields.json"

if [[ ! -f "$FIELDS_JSON" ]]; then
    echo "Error: Template not found at $FIELDS_JSON"
    exit 1
fi

echo "Setting up project $PROJECT_ID with template '$TEMPLATE_NAME'..."
echo ""

# --- Verify project exists ---
PROJECT_TITLE=$(gh api graphql -f query="
{
  node(id: \"$PROJECT_ID\") {
    ... on ProjectV2 { title }
  }
}" --jq '.data.node.title')

if [[ -z "$PROJECT_TITLE" || "$PROJECT_TITLE" == "null" ]]; then
    echo "Error: Could not find project with ID $PROJECT_ID"
    exit 1
fi

echo "Found project: $PROJECT_TITLE"
echo ""

# --- Get existing fields to find Status field ID ---
EXISTING_FIELDS=$(gh api graphql -f query="
{
  node(id: \"$PROJECT_ID\") {
    ... on ProjectV2 {
      fields(first: 30) {
        nodes {
          ... on ProjectV2Field {
            id
            name
            dataType
          }
          ... on ProjectV2SingleSelectField {
            id
            name
            dataType
            options { id name }
          }
        }
      }
    }
  }
}" --jq '.data.node.fields.nodes')

# --- Build output JSON ---
GENERATED='{"project_id":"'"$PROJECT_ID"'","project_title":"'"$PROJECT_TITLE"'","template":"'"$TEMPLATE_NAME"'","fields":{}}'

# --- Process each field ---
FIELD_COUNT=$(jq '.fields | length' "$FIELDS_JSON")

for i in $(seq 0 $((FIELD_COUNT - 1))); do
    FIELD=$(jq ".fields[$i]" "$FIELDS_JSON")
    FIELD_NAME=$(echo "$FIELD" | jq -r '.name')
    FIELD_TYPE=$(echo "$FIELD" | jq -r '.type')
    IS_BUILTIN=$(echo "$FIELD" | jq -r '.builtin // false')

    echo "Processing field: $FIELD_NAME ($FIELD_TYPE)..."

    if [[ "$IS_BUILTIN" == "true" ]]; then
        # Find existing field ID
        FIELD_ID=$(echo "$EXISTING_FIELDS" | jq -r ".[] | select(.name == \"$FIELD_NAME\") | .id")

        if [[ -z "$FIELD_ID" || "$FIELD_ID" == "null" ]]; then
            echo "  Warning: Builtin field '$FIELD_NAME' not found on project, skipping."
            continue
        fi

        # Update options
        OPTIONS_ARGS=""
        OPT_COUNT=$(echo "$FIELD" | jq '.options | length')
        for j in $(seq 0 $((OPT_COUNT - 1))); do
            OPT_NAME=$(echo "$FIELD" | jq -r ".options[$j].name")
            OPT_COLOR=$(echo "$FIELD" | jq -r ".options[$j].color")
            OPT_DESC=$(echo "$FIELD" | jq -r ".options[$j].description // empty")
            if [[ -n "$OPT_DESC" ]]; then
                OPTIONS_ARGS="$OPTIONS_ARGS { name: \"$OPT_NAME\", color: $OPT_COLOR, description: \"$OPT_DESC\" }"
            else
                OPTIONS_ARGS="$OPTIONS_ARGS { name: \"$OPT_NAME\", color: $OPT_COLOR }"
            fi
        done

        RESULT=$(gh api graphql -f query="
        mutation {
          updateProjectV2Field(input: {
            fieldId: \"$FIELD_ID\"
            singleSelectOptions: [$OPTIONS_ARGS]
          }) {
            projectV2Field {
              ... on ProjectV2SingleSelectField {
                id
                options { id name }
              }
            }
          }
        }" --jq '.data.updateProjectV2Field.projectV2Field')

        # Build options map
        OPTIONS_MAP="{}"
        RESULT_OPT_COUNT=$(echo "$RESULT" | jq '.options | length')
        for j in $(seq 0 $((RESULT_OPT_COUNT - 1))); do
            OPT_ID=$(echo "$RESULT" | jq -r ".options[$j].id")
            OPT_NAME=$(echo "$RESULT" | jq -r ".options[$j].name")
            OPTIONS_MAP=$(echo "$OPTIONS_MAP" | jq --arg name "$OPT_NAME" --arg id "$OPT_ID" '.[$name] = $id')
        done

        GENERATED=$(echo "$GENERATED" | jq --arg name "$FIELD_NAME" --arg id "$FIELD_ID" --argjson opts "$OPTIONS_MAP" '.fields[$name] = {"id": $id, "options": $opts}')
        echo "  Updated with $RESULT_OPT_COUNT options."

    else
        # Create new field
        if [[ "$FIELD_TYPE" == "SINGLE_SELECT" ]]; then
            OPTIONS_ARGS=""
            OPT_COUNT=$(echo "$FIELD" | jq '.options | length')
            for j in $(seq 0 $((OPT_COUNT - 1))); do
                OPT_NAME=$(echo "$FIELD" | jq -r ".options[$j].name")
                OPT_COLOR=$(echo "$FIELD" | jq -r ".options[$j].color")
                OPT_DESC=$(echo "$FIELD" | jq -r ".options[$j].description // empty")
                if [[ -n "$OPT_DESC" ]]; then
                    OPTIONS_ARGS="$OPTIONS_ARGS { name: \"$OPT_NAME\", color: $OPT_COLOR, description: \"$OPT_DESC\" }"
                else
                    OPTIONS_ARGS="$OPTIONS_ARGS { name: \"$OPT_NAME\", color: $OPT_COLOR }"
                fi
            done

            RESULT=$(gh api graphql -f query="
            mutation {
              createProjectV2Field(input: {
                projectId: \"$PROJECT_ID\"
                dataType: SINGLE_SELECT
                name: \"$FIELD_NAME\"
                singleSelectOptions: [$OPTIONS_ARGS]
              }) {
                projectV2Field {
                  ... on ProjectV2SingleSelectField {
                    id
                    options { id name }
                  }
                }
              }
            }" --jq '.data.createProjectV2Field.projectV2Field')

            FIELD_ID=$(echo "$RESULT" | jq -r '.id')
            OPTIONS_MAP="{}"
            RESULT_OPT_COUNT=$(echo "$RESULT" | jq '.options | length')
            for j in $(seq 0 $((RESULT_OPT_COUNT - 1))); do
                OPT_ID=$(echo "$RESULT" | jq -r ".options[$j].id")
                OPT_NAME=$(echo "$RESULT" | jq -r ".options[$j].name")
                OPTIONS_MAP=$(echo "$OPTIONS_MAP" | jq --arg name "$OPT_NAME" --arg id "$OPT_ID" '.[$name] = $id')
            done

            GENERATED=$(echo "$GENERATED" | jq --arg name "$FIELD_NAME" --arg id "$FIELD_ID" --argjson opts "$OPTIONS_MAP" '.fields[$name] = {"id": $id, "options": $opts}')
            echo "  Created with $RESULT_OPT_COUNT options."

        elif [[ "$FIELD_TYPE" == "NUMBER" ]]; then
            FIELD_ID=$(gh api graphql -f query="
            mutation {
              createProjectV2Field(input: {
                projectId: \"$PROJECT_ID\"
                dataType: NUMBER
                name: \"$FIELD_NAME\"
              }) {
                projectV2Field {
                  ... on ProjectV2Field { id }
                }
              }
            }" --jq '.data.createProjectV2Field.projectV2Field.id')

            GENERATED=$(echo "$GENERATED" | jq --arg name "$FIELD_NAME" --arg id "$FIELD_ID" '.fields[$name] = {"id": $id}')
            echo "  Created."

        elif [[ "$FIELD_TYPE" == "TEXT" ]]; then
            FIELD_ID=$(gh api graphql -f query="
            mutation {
              createProjectV2Field(input: {
                projectId: \"$PROJECT_ID\"
                dataType: TEXT
                name: \"$FIELD_NAME\"
              }) {
                projectV2Field {
                  ... on ProjectV2Field { id }
                }
              }
            }" --jq '.data.createProjectV2Field.projectV2Field.id')

            GENERATED=$(echo "$GENERATED" | jq --arg name "$FIELD_NAME" --arg id "$FIELD_ID" '.fields[$name] = {"id": $id}')
            echo "  Created."

        else
            echo "  Warning: Unsupported field type '$FIELD_TYPE', skipping."
        fi
    fi
done

echo ""
echo "Setup complete!"
echo ""

# --- Output ---
PRETTY=$(echo "$GENERATED" | jq '.')

if [[ -n "$OUTPUT_PATH" ]]; then
    mkdir -p "$(dirname "$OUTPUT_PATH")"
    echo "$PRETTY" > "$OUTPUT_PATH"
    echo "Generated IDs written to: $OUTPUT_PATH"
else
    echo "Generated IDs (save this to your repo's .github/ directory):"
    echo ""
    echo "$PRETTY"
fi
