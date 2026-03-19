# TRPG Workbench Editor

The TRPG Workbench Editor is another active project Terminus should be able to help Dan design, explain, refine, and position.

It is a specialized markdown editor and workflow tool for tabletop RPG authors.

Its purpose is not generic writing assistance. It is a production workbench for:

- drafting adventure modules
- formatting and cleanup
- stat block management
- flow visualization
- structure validation
- narrative tooling
- project integrity across large manuscripts

## Core identity

The Workbench is an authoring environment built around workflow reliability.

It combines:

- markdown editing
- TRPG-specific formatting tools
- project structure navigation
- validation and cleanup pipelines
- AI-assisted narrative and classification features
- integrity and audit systems for real publishing workflows

This should be framed as a serious authoring tool, not a novelty editor.

## Core interface model

The interface is built around a three-column workflow:

- left sidebar for tools and pipeline actions
- center panel for editor, flowmap, conversion, table tools, and activity
- right sidebar for navigator and Seneschal

There is also a dedicated Stat Block Navigator for creatures, NPCs, traps, and hazards.

## Important workflow features

Key authoring workflows include:

- markdown editing with TRPG-specific toolbar actions
- DOCX import and comment extraction
- stat block detection and review status tracking
- flowmap visualization from document structure
- structure validation for headers, empty sections, and broken links
- export workflows for markdown, clean markdown, DOCX, and to-do lists

The product value comes from reducing manuscript friction and preserving structural clarity through the whole lifecycle.

## Seneschal and narrative systems

The Seneschal is the AI co-author layer.

Important constraints:

- Seneschal AI features are BYOK-only
- missing or disabled API access should block Seneschal actions cleanly
- conversation history and input stay visible while tools/settings are collapsible

Narrative Systems is a grounded story generation and validation engine connected to:

- World Bible
- Developer Notes
- Canon Registry

Three important roles are:

- Adventure Architect
- Hooksmith
- Canon Warden

These should be treated as functional narrative lenses, not as decorative personas.

## World Bible architecture

The Workbench includes a structured World Bible system with:

- scaffolded domain folders
- presentation vs foundations split
- `bible_manifest.json` as source of truth
- CLI and UI scaffolding flows
- organizer workflows for self-healing file placement

This matters because the product is not just an editor. It is also a world-knowledge orchestration layer for narrative generation and validation.

## Integrity and audit model

The Workbench places heavy emphasis on integrity and recoverability.

Important features include:

- Sentinel checks for invalid or unsafe state
- clean markdown export for external editing
- rehydration workflow to restore attribution tags
- project manifests and chapter navigation
- import-to-dos
- chaos tracker and activity pane
- version snapshots and attribution
- entity registry and drift detection

This means the product should be framed around safe high-churn authoring, not just convenience features.

## Chaos management

The Chaos Tracker exists to survive revision storms and multi-author workflows.

Key ideas:

- session author detection and override
- author handoff visualization
- robust snapshot history
- entity extraction on save
- project-wide entity drift detection
- auditable activity logs

This is important because the Workbench has to hold up under real editorial churn, not just solo drafting.

## Design philosophy

The Workbench should be understood as:

- author-first
- manuscript-structure-aware
- publishing-workflow-aware
- validation-heavy where errors compound
- flexible enough to support external tools without losing internal integrity

The system is strongest when it makes complex editorial workflows safer, more visible, and easier to recover.

## How Terminus should help

When helping with the TRPG Workbench, Terminus should:

- frame it as a production tool for RPG authors, not a generic editor
- preserve the distinction between editor workflow, narrative systems, and integrity systems
- treat World Bible, Canon Registry, Seneschal, and Chaos Tracker as core architecture, not side features
- help reason about user workflow, failure modes, validation gaps, and author handoff reliability
- pay attention to BYOK constraints, publishing exports, manuscript integrity, and rehydration flows

Useful help includes:

- clarifying feature positioning
- tightening workflow explanations
- identifying where validation or audit features prevent real publishing mistakes
- aligning UI and terminology with the actual job-to-be-done of RPG authors
