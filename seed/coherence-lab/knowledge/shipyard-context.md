# Shipyard: Vessel, Woven Map, and Raven Calder

## Overview
**Shipyard** is the parent development environment and repository for the V3 next-generation astrological engine and its frontend client, **Vessel**. Within Vessel lives the **Woven Map**, an interactive interface guided by the AI persona **Raven Calder**.

## Core Components
### Vessel (V3)
- **Local-First Architecture:** Replaced legacy, error-prone cloud sync with a streamlined `vaultSync.ts` orchestrator and local-first data storage.
- **Advanced Profile Vault:** A multi-tabbed interface supporting Profiles, Pairs/Synastry, Lenses, and manual Backup/Recovery. 
- **Vault Staging Pill & Context Gating:** Enables staging multiple profiles for comparative analyses (like Synastry/Relationship Mapping). Includes strict "Perspective Integrity" to ensure structural boundaries between the primary user and observed subjects (Self vs. Observer mode).

### The Woven Map & Raven Calder
- **Raven Calder:** The presiding AI persona built on "Affirmative Pathways." It relies on positive prompt structures (allow-lists, approved vocabulary) rather than prohibitive "Do not" prompts ("Pink Elephant Vulnerability") to reduce cognitive load and avoid paradoxical priming.
- **The Four Guided Vectors:** The primary reading shapes available are Natal Blueprint, Relationship Mapping, Current Cycle, and Open Field.
- **Alignment Corridor (Zodiac Ribbon):** The ambient instrument UI. It displays high-fidelity Unicode astrological glyphs that react to live telemetry signals (DORMANT, PRIMED, ACTIVE, STABLE states) without needing background cloud synchronization.
- **Relational Balance Meter:** Extracts raw math into a diagnostic tag measuring architectural intensity ("magnitude"), bias, and coherence, translating abstract geometry into visible telemetry.

## SHERLOG Integration
Shipyard utilizes **SHERLOG**, a repo-aware preflight CLI for AI-assisted development (verify, doctor, gaps, hygiene) to detect code gaps, track velocity, and maintain rigid documentation hygiene on the live code seams.

## Driving Philosophies
1. **Instrument over Oracle:** Raven translates geometry into meaning but insists on causality flowing from lived experience, not the stars.
2. **Signal Before Schema:** Structural metrics and instrument telemetry precede internal narrative generation.
3. **Continuity & Context Maps:** Explicit caching, session markers (Flight Recorder phases), and deterministic fallback rails support cross-read stability for the user.
