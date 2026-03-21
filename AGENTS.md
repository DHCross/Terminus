# Agent Guide

<!-- SHERLOG START -->
## Sherlog Preflight (Required)

Before proposing plans, estimates, or implementation order for a feature, run:

```bash
npm run sherlog:verify -- --json
npm run sherlog:doctor -- --feature "Feature Name" --json
npm run sherlog:gaps -- --feature "Feature Name" --json
npm run sherlog:prompt -- "Feature Name"
```

## Sherlog Session Contract (Required)

Run session tracking for every coding session:

```bash
npm run sherlog:session:start -- "Feature Name"
npm run sherlog:session:note -- "what changed"
npm run sherlog:session:prompt -- --lookback 5
npm run sherlog:session:end
```

If `settings.session_autostart_on_feature_commands` is true, `doctor`/`gaps`/`prompt`/`estimate` should auto-start a session when none is active.

Use `/docs/sherlog-next-steps.md` and `/docs/why-sherlog.md` as the local operating guide.
<!-- SHERLOG END -->

## Artifact Creation Defaults

When the user asks for a file deliverable, create the file directly in the workspace instead of substituting a text response.

Examples:

- `.docx` request: use the `doc` skill and create the `.docx`
- `.pdf` request: use the `pdf` skill and create the `.pdf`
- `.xlsx` or `.csv` request: use the `spreadsheet` skill and create the file
- `.ipynb` request: use the `jupyter-notebook` skill and create the notebook

Do not default to Markdown, plain text, or "here is content you can paste" unless:

- the user explicitly asks for raw text only
- the required toolchain is unavailable
- file creation fails, in which case explain the failure briefly and then provide the fallback

## Tool Proactivity

Before replying with a workaround, check whether an available skill or local tool can complete the task directly.

If a matching skill exists, use it by default. Prefer producing the requested artifact over describing how the user could produce it manually.

## Avoid Weak Fallback Assumptions

Do not assume you cannot create, edit, or save files in the workspace. First verify whether the workspace and available skills support the requested output. If they do, perform the work.
