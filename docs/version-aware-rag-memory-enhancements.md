# Version-Aware RAG Memory Enhancements

## Purpose

Turn Terminus from a plain semantic-retrieval layer into a continuity-aware knowledge system that can:

- ingest revised documents without losing lineage
- distinguish durable memory from long-form library material
- promote high-value passages into reusable memory objects
- generate morning summaries from document and session deltas
- retrieve by concept, claim, and recency rather than chunk similarity alone

This feature is aimed at Terminus as configured through Sapphire's existing continuity scaffolding, memory, knowledge, and recurring task surfaces.

## Why This Feature Exists

The current project already treats continuity as a first-class concern:

- `seed/coherence-lab/README.md` positions Sapphire as a continuity scaffold
- `seed/coherence-lab/continuity/tasks.json` already defines recurring daily brief and journal loops
- `seed/coherence-lab/knowledge/logos-theory-abstract.md` explicitly frames memory and knowledge as experimental infrastructure

What is missing is a version-aware layer between raw documents and retrieval. Right now the likely failure modes are:

- updated essays are re-added as unrelated knowledge blobs
- morning summaries repeat old material because they cannot see what changed
- retrieval finds semantically similar chunks but cannot prefer the latest revision
- memorable formulations remain buried in long documents instead of becoming durable anchors

The updated essays below are a good first benchmark because they are dense, overlapping, revised, and concept-heavy:

- `/Users/dancross/Downloads/files/coherence-engines.md`
- `/Users/dancross/Downloads/files/promethean-creation.md`

## Product Framing

This should be framed as support for vibe coders who want the AI to stay in charge of the workflow, not as a supervisory layer that takes the workflow away from them.

That means:

- Sherlog is an on-demand instrument the agent calls when it needs sharper context, gap detection, or delivery grounding.
- The continuity and RAG system should strengthen the agent's judgment during active work rather than behave like a background manager issuing commands.
- Morning summaries, anchors, and revision deltas should help the agent maintain initiative with less drift, less repetition, and less manual context restatement.

The practical promise is not "more process." It is "the AI keeps its bearings while the human stays in a high-level, intent-first mode."

## Product Goal

Given a revised document corpus, Terminus should be able to answer:

1. What is new since the last version?
2. Which claims were sharpened, corrected, or reframed?
3. Which passages should be promoted into durable memory or quote anchors?
4. What belongs in today's morning summary?
5. When asked a later question, which version should retrieval trust first?

## Non-Goals

- proving Logos Theory
- building a general-purpose enterprise document platform
- replacing Sapphire's existing memory and knowledge primitives
- requiring a specific vector database before the data model is proven

## Design Principles

1. Continuity over raw recall
   Retrieval should preserve structural history, not just find similar text.

2. Version lineage over overwrite
   New documents should not destroy older context; they should supersede it with traceable ancestry.

3. Curated memory over indiscriminate chunking
   Important claims and quotes should be elevated into higher-signal objects.

4. Retrieval routing over single-pool search
   Theory, worldbuilding, and session memory should not compete in one undifferentiated vector space.

5. Evaluation before infrastructure lock-in
   A strong local-first data model matters more initially than whether the backend is Chroma, Qdrant, or SQLite plus embeddings.

6. Instrument, not overseer
   Sherlog and retrieval should be invoked by the agent in service of the current task, not operate as a separate workflow authority.

## Proposed Capability Set

### 1. Version-Aware Ingestion

When a document is ingested, the pipeline should:

1. compute a stable source identity
2. detect whether this is a new document or a revision
3. preserve the previous version
4. attach revision metadata
5. diff the old and new versions at a section or chunk level
6. emit delta events for summary and retrieval

Minimum metadata per document version:

- `source_id`
- `version_id`
- `title`
- `domain` such as `logos_theory` or `raven_calder`
- `ingested_at`
- `source_path`
- `supersedes_version_id`
- `content_hash`
- `summary`

Minimum metadata per chunk:

- `chunk_id`
- `source_id`
- `version_id`
- `section_heading`
- `chunk_index`
- `text`
- `embedding`
- `is_changed`
- `change_type` as `added`, `modified`, `unchanged`, or `removed`

### 2. Tiered Memory Model

Split retrieval into explicit stores:

- `session_memory`
  Recent conversational state and short-lived context.
- `durable_memory`
  High-value claims, notes, and promoted quote anchors.
- `library_documents`
  Full essays, notes, configs, and other long-form sources.
- `domain_indexes`
  Logical partitions such as `logos_theory` and `raven_calder`.

This avoids a common failure mode where a good quote, a stale draft paragraph, and a one-off session aside all rank together.

### 3. Quote Promotion and Anchor Objects

Not every good passage should remain a chunk. The system should be able to promote selected text into a durable object with higher retrieval priority.

Suggested object type: `anchor_note`

Fields:

- `anchor_id`
- `kind` such as `morning_quote`, `thesis`, `reframe`, `warning`, `open_question`
- `text`
- `source_id`
- `version_id`
- `source_excerpt_location`
- `implication`
- `domain`
- `importance`
- `created_at`
- `superseded_by`

Examples from the updated essays:

- the self-report confounder is a methodological warning
- "coherence engine" is a thesis-level framing
- "People Spirit" is a named anti-pattern
- crystallization / Prometheation is a reusable explanatory frame

### 4. Morning Summary Objects

The existing daily brief task is a natural host for a stronger output contract.

Suggested generated object: `morning_summary`

Fields:

- `summary_id`
- `generated_at`
- `date_scope`
- `sources_considered`
- `new_claims`
- `updated_claims`
- `promoted_anchors`
- `open_questions`
- `suggested_next_step`

Target behavior:

- summarize only deltas since the prior run
- prefer revised documents and newly promoted anchors
- separate "new material" from "still important but unchanged"

### 5. Retrieval Routing

Before vector search, classify the query into one or more intents:

- theory lookup
- worldbuilding lookup
- continuity recap
- quote retrieval
- update/diff request
- synthesis request

Routing then controls:

- which domain index to search
- whether anchor notes receive a score boost
- whether latest-version chunks are preferred
- whether summaries should be consulted before raw documents

### 6. Claim and Implication Extraction

For essays like the two benchmark files, chunk-level retrieval is not enough. The system should optionally extract structured claim objects.

Suggested object type: `claim_note`

Fields:

- `claim_id`
- `claim_text`
- `supporting_context`
- `implication`
- `status` as `active`, `reframed`, `questioned`, or `superseded`
- `source_id`
- `version_id`
- `domain`

This matters because later queries are likely to ask for the argument, not the paragraph.

### 7. Contradiction and Reframe Tracking

Because the corpus explicitly deals with refinement and confounders, the system should track:

- claims repeated across documents
- claims materially revised across versions
- warnings introduced after earlier optimism
- unresolved tensions between essays, sessions, and memory

This is more aligned with the repo's research orientation than a standard "top 5 similar chunks" retrieval layer.

## Suggested Architecture

Keep the first implementation local-first and modular:

1. Ingestion layer
   Parse Markdown, normalize headings, split into chunks, diff against prior version.

2. Metadata store
   Store document versions, claims, anchors, summaries, and lineage.

3. Embedding layer
   Generate embeddings for chunks, anchors, and optionally claims.

4. Retrieval layer
   Route query, retrieve candidates from the right tier, rerank by version and object type.

5. Agent instrumentation layer
   Expose retrieval, diff, and summary primitives as tools the agent can call on demand while staying in control of the workflow.

6. Synthesis layer
   Produce morning summaries, update reports, and answer generation context.

Backend options:

- start with SQLite plus an embedding table if simplicity matters most
- use Chroma if fast local experimentation is the priority
- use Qdrant if you expect more explicit filtering, reranking, or scale

Recommendation:

Start with the data model and evaluation contract first. Do not commit to a vector backend until the revision and summary behavior is tested against the benchmark corpus.

## Benchmark Corpus

Primary benchmark inputs:

- `/Users/dancross/Downloads/files/coherence-engines.md`
- `/Users/dancross/Downloads/files/promethean-creation.md`

Why they are strong tests:

- both are revised long-form essays
- both share a concept vocabulary
- both contain named frames and methodological distinctions
- both are likely to generate overlapping but non-identical retrieval hits
- both contain passages suitable for quote promotion and claim extraction

Secondary benchmark inputs:

- `seed/coherence-lab/knowledge/*.md`
- continuity task outputs and future morning summaries
- future Logos Theory drafts
- future Raven Calder / Woven Map materials

## Acceptance Criteria

The feature is useful only if it can do all of the following with the benchmark corpus:

1. Detect that a newly ingested article is a revision of an existing source rather than an unrelated file.
2. Produce a structured diff summary that identifies changed sections and newly introduced claims.
3. Promote at least several high-signal passages into anchor notes with implications.
4. Generate a morning summary that focuses on deltas rather than restating the whole essay.
5. Answer a later query using the newest relevant version by default while preserving access to prior versions.
6. Distinguish theory-framing queries from continuity-recap queries.
7. Surface at least one explicit reframe or confounder introduced by the updated essays.

## Evaluation Plan

### Phase 1: Ingestion and Diff

Input:

- prior versions of the two essays if available
- current versions from Downloads

Checks:

- revision linking is correct
- changed chunks are marked
- unchanged chunks do not dominate the delta summary

### Phase 2: Anchor Promotion

Run anchor extraction and manually inspect whether the promoted set includes material like:

- self-report as confounder
- coherence engine as structural framing
- People Spirit as anti-pattern
- crystallization / Prometheation as collaboration model

Failure modes:

- generic sentences promoted over thesis statements
- duplicate anchors from adjacent chunks
- no implication metadata

### Phase 3: Morning Summary

Generate a morning summary after ingestion.

Success conditions:

- summary emphasizes what changed
- summary includes promoted anchors
- summary suggests a concrete next step
- summary does not re-summarize every section of both essays

### Phase 4: Retrieval Behavior

Test prompts such as:

- "What changed in the updated coherence engines essay?"
- "What is the strongest methodological warning in the corpus?"
- "How does Prometheation differ from the People Spirit framing?"
- "Give me the latest formulation of the self-report confounder."
- "What should go into today's morning summary?"

Success conditions:

- latest relevant version is preferred
- anchors and claims outrank mediocre raw chunks
- cross-document synthesis works without collapsing the documents together

### Phase 5: Continuity Fit

Check whether the output naturally fits the existing continuity task model in `seed/coherence-lab/continuity/tasks.json`.

Success conditions:

- daily brief can consume deltas and anchors
- future recurring tasks can write back promoted memory cleanly
- no feature requires abandoning the current continuity scaffold

## Implementation Sequence

1. Define the data model for document versions, chunks, anchors, claims, and summaries.
2. Build revision-aware Markdown ingestion with stable source IDs.
3. Add chunk diffing and delta event generation.
4. Add anchor promotion and implication tagging.
5. Add morning summary generation from deltas plus anchors.
6. Add retrieval routing and latest-version preference.
7. Add evaluation fixtures and prompt-based retrieval tests using the benchmark essays.

## Open Questions

- Should anchor promotion be fully automatic, human-curated, or mixed?
- Should morning summaries write back into memory automatically or remain reviewable artifacts first?
- Is SQLite enough for the first version if metadata and lineage do most of the work?
- Should old versions remain searchable by default or only through explicit historical queries?
- How should Raven Calder / Woven Map materials be partitioned once that corpus exists?

## Recommended First Slice

If the goal is to get signal fast, the first slice should be:

1. ingest the two updated essays as versioned documents
2. diff them against prior copies if present
3. generate a morning summary object
4. extract a small set of anchor notes
5. test a handful of retrieval prompts against the result

That is enough to validate the model before building a larger RAG substrate around it.

## Implementation Details

The initial version of the RAG ingester has been implemented as `seed/coherence-lab/knowledge/rag_ingester.py`. It is a Python script that parses Markdown files, splits them into chunk objects based on headings, generates stable `source_id`s, and handles basic diffing between current and previous versions (identifying added, modified, and unchanged sections). This script can be called directly or run by higher-level systems within Terminus. A corresponding test file `sherlog-velocity/test/rag-ingester.test.js` has been created and verified to run the ingester via subprocess, testing logic for parsing new files and correctly identifying differences between file revisions.
