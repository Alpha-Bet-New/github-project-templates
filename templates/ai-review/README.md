# AI Review Template

Multi-model AI review workflow for code audits, framework reviews, and spec validation.

## How It Works

1. **Propose**: An AI model (Claude, Gemini, Codex) reviews a codebase or document and creates issues for problems found. Each issue gets:
   - `Model` — which model found it
   - `Issue Type` — what kind of problem (Code Bug, Math Bug, Spec Deviation, Doc Fix)
   - `Confidence Level` — 1-10 self-assessed confidence
   - `Status` — starts at "Proposed"

2. **Cross-Review**: Other models review the findings and set their Reviewer field (Agreed / Mostly Agreed / Disagree). A model never reviews its own issues.

3. **Approve**: A human reviews cross-validated issues and moves approved ones from "Proposed" to "Todo".

4. **Implement**: Standard Todo → In Progress → Done workflow.

## Field Definitions

See `fields.json` for the machine-readable schema. Key distinctions:

### Issue Type

| Type | When to use |
|---|---|
| **Code Bug** | Would crash, throw an exception, or produce clearly wrong behavior |
| **Math Bug** | Formula error that **silently** produces wrong numbers (no crash) |
| **Spec Deviation** | Code differs from spec but neither is necessarily wrong |
| **Doc Fix** | Document wording/clarity issue; codebase is fine |

**Math Bug vs Spec Deviation:** If one formula is objectively wrong, it's a Math Bug. If both are valid but they disagree, it's a Spec Deviation.

### Confidence Level (1-10)

| Score | Meaning |
|---|---|
| 9-10 | Objectively verifiable. Would cause runtime failure or provably wrong results. |
| 7-8 | Strong evidence. Fix is clearly beneficial. |
| 5-6 | Debatable. Current behavior may be acceptable. |
| 3-4 | Mild concern. Could be intentional. |
| 1-2 | Cosmetic or stylistic. |

## Setup

```bash
# From this repo's root:
./scripts/setup-project.sh <PROJECT_ID> ai-review
```

This creates all custom fields on the target project. Run it once per project.

## Notes

- Custom fields must be manually added to View 1 in the GitHub UI after setup (API limitation).
- The setup script outputs a `_generated_ids.json` file with the runtime field/option IDs for the specific project. Commit this to the target repo's `.github/` directory so AI models can reference the IDs.
