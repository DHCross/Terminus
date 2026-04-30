#!/usr/bin/env python3
import json
import argparse
from datetime import datetime, timezone
import hashlib
import os
import re

MAX_PROMOTED_OBJECTS = 8

QUESTION_RE = re.compile(r'([^.!?\n]*\?)')
SENTENCE_RE = re.compile(r'(?<=[.!?])\s+|\n+')
CORRECTION_RE = re.compile(r'\[CORRECTION_EVENT\]', re.IGNORECASE)
CLAIM_RE = re.compile(
    r'\b(is|are|means|suggests|implies|should|must|hypothesis|claim|theory|evidence)\b',
    re.IGNORECASE,
)
ANCHOR_RE = re.compile(
    r'\b(primary research data|thesis|warning|confounder|anti-pattern|failure mode|next step|falsif|coherence engine|promoted anchor)\b',
    re.IGNORECASE,
)

def compute_hash(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()

def utc_now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()

def slugify(value):
    slug = re.sub(r'[^a-z0-9]+', '-', value.lower()).strip('-')
    return slug or 'document'

def stable_source_name(file_path):
    stem = os.path.splitext(os.path.basename(file_path))[0]
    stem = re.sub(r'[-_](prev|previous|old|new|v\d+|draft\d*)$', '', stem, flags=re.IGNORECASE)
    return slugify(stem)

def infer_domain(file_path, explicit_domain=None):
    if explicit_domain:
        return explicit_domain

    basename = os.path.basename(file_path).lower()
    parent = os.path.basename(os.path.dirname(file_path)).lower()
    meaningful_parent = parent if parent in {'continuity', 'traces', 'journal'} else ''
    normalized = f"{meaningful_parent}/{basename}" if meaningful_parent else basename
    if any(token in normalized for token in ['logos', 'coherence', 'promethean', 'pink-elephant']):
        return 'logos_theory'
    if any(token in normalized for token in ['trpg', 'raven', 'shipyard']):
        return 'worldbuilding'
    if any(token in normalized for token in ['trace', 'continuity', 'journal']):
        return 'continuity'
    if 'sherlog' in normalized:
        return 'workflow_instrumentation'
    return 'general'

def summarize_text(text, limit=240):
    compact = re.sub(r'\s+', ' ', text).strip()
    if len(compact) <= limit:
        return compact
    return compact[:limit - 3].rstrip() + '...'

def load_json_file(path, default=None):
    if not path or not os.path.exists(path):
        return default
    with open(path, 'r', encoding='utf-8') as handle:
        return json.load(handle)

def write_json_file(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2)
        handle.write('\n')

def append_jsonl(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a', encoding='utf-8') as handle:
        handle.write(json.dumps(payload))
        handle.write('\n')

def build_state_paths(state_dir, source_id, version_id=None):
    source_index_path = os.path.join(state_dir, 'sources', f'{source_id}.json')
    versions_dir = os.path.join(state_dir, 'versions', source_id)
    paths = {
        'source_index': source_index_path,
        'versions_dir': versions_dir,
        'ingest_log': os.path.join(state_dir, 'ingests.jsonl'),
    }
    if version_id:
        paths['artifact'] = os.path.join(versions_dir, f'{version_id}.json')
    return paths

def build_source_index(source_id, title, domain):
    return {
        'version': 1,
        'source_id': source_id,
        'title': title,
        'domain': domain,
        'latest_version_id': None,
        'latest_artifact_path': None,
        'last_ingested_at': None,
        'ingest_count': 0,
        'versions': [],
        'latest_snapshot': None,
    }

def load_source_index(state_dir, source_id, title, domain):
    paths = build_state_paths(state_dir, source_id)
    source_index = load_json_file(paths['source_index'])
    if not isinstance(source_index, dict):
        return build_source_index(source_id, title, domain)

    source_index.setdefault('version', 1)
    source_index.setdefault('source_id', source_id)
    source_index.setdefault('title', title)
    source_index.setdefault('domain', domain)
    source_index.setdefault('latest_version_id', None)
    source_index.setdefault('latest_artifact_path', None)
    source_index.setdefault('last_ingested_at', None)
    source_index.setdefault('ingest_count', 0)
    source_index.setdefault('versions', [])
    source_index.setdefault('latest_snapshot', None)
    return source_index

def extract_previous_chunks(previous_artifact):
    previous_chunks = []
    for chunk in previous_artifact.get('chunks', []):
        text = chunk.get('text')
        if not text:
            continue
        previous_chunks.append({
            'section_heading': chunk.get('section_heading', 'Document Root'),
            'text': text,
        })
    return previous_chunks

def load_previous_artifact_from_state(state_dir, source_id, title, domain):
    if not state_dir:
        return build_source_index(source_id, title, domain), None

    source_index = load_source_index(state_dir, source_id, title, domain)
    artifact_rel_path = source_index.get('latest_artifact_path')
    if not artifact_rel_path:
        return source_index, None

    artifact_path = os.path.join(state_dir, artifact_rel_path)
    previous_artifact = load_json_file(artifact_path)
    if not isinstance(previous_artifact, dict):
        return source_index, None
    return source_index, previous_artifact

def build_latest_snapshot(document_metadata):
    changed_sections = [
        {
            'section_heading': event['section_heading'],
            'change_type': event['change_type'],
            'summary': event['summary'],
        }
        for event in document_metadata['delta_events']
        if event['change_type'] != 'unchanged'
    ][:3]
    return {
        'summary': document_metadata['summary'],
        'morning_summary': {
            'summary_id': document_metadata['morning_summary']['summary_id'],
            'updated_claims': document_metadata['morning_summary']['updated_claims'][:3],
            'promoted_anchors': document_metadata['morning_summary']['promoted_anchors'][:3],
            'open_questions': document_metadata['morning_summary']['open_questions'][:3],
            'suggested_next_step': document_metadata['morning_summary']['suggested_next_step'],
        },
        'research_state': {
            'active_hypothesis_count': len(document_metadata['research_state']['active_hypotheses']),
            'confounder_count': len(document_metadata['research_state']['confounders']),
            'correction_event_count': len(document_metadata['research_state']['correction_events']),
            'open_questions': document_metadata['research_state']['open_questions'][:3],
            'next_discriminating_experiment': document_metadata['research_state']['next_discriminating_experiment'],
        },
        'continuity_cockpit': {
            'what_changed': changed_sections,
            'next_action': document_metadata['continuity_cockpit']['next_action'],
        },
        'anchor_note_count': len(document_metadata['anchor_notes']),
        'claim_note_count': len(document_metadata['claim_notes']),
        'evaluation_signals': document_metadata['evaluation_signals'],
    }

def determine_output_mode(requested_output_mode, state_dir):
    if requested_output_mode == 'auto':
        return 'compact' if state_dir else 'full'
    return requested_output_mode

def build_compact_output(document_metadata):
    changed_sections = [
        {
            'section_heading': event['section_heading'],
            'change_type': event['change_type'],
            'summary': event['summary'],
        }
        for event in document_metadata['delta_events']
        if event['change_type'] != 'unchanged'
    ][:3]
    return {
        'output_mode': 'compact',
        'source_id': document_metadata['source_id'],
        'version_id': document_metadata['version_id'],
        'title': document_metadata['title'],
        'domain': document_metadata['domain'],
        'ingested_at': document_metadata['ingested_at'],
        'supersedes_version_id': document_metadata['supersedes_version_id'],
        'summary': document_metadata['summary'],
        'state_store': document_metadata.get('state_store'),
        'counts': {
            'chunks': len(document_metadata['chunks']),
            'delta_events': len(document_metadata['delta_events']),
            'anchor_notes': len(document_metadata['anchor_notes']),
            'claim_notes': len(document_metadata['claim_notes']),
            'correction_events': len(document_metadata['correction_events']),
        },
        'highlights': {
            'changed_sections': changed_sections,
            'promoted_anchors': [anchor['text'] for anchor in document_metadata['anchor_notes'][:3]],
            'new_claims': [claim['claim_text'] for claim in document_metadata['claim_notes'][:3]],
            'open_questions': document_metadata['research_state']['open_questions'][:3],
            'next_action': document_metadata['continuity_cockpit']['next_action'],
        },
        'morning_summary': {
            'summary_id': document_metadata['morning_summary']['summary_id'],
            'suggested_next_step': document_metadata['morning_summary']['suggested_next_step'],
        },
        'evaluation_signals': document_metadata['evaluation_signals'],
    }

def format_output(document_metadata, output_mode):
    if output_mode == 'compact':
        return build_compact_output(document_metadata)

    result = dict(document_metadata)
    result['output_mode'] = 'full'
    return result

def update_source_versions(existing_versions, document_metadata, artifact_rel_path):
    versions = [
        version for version in existing_versions
        if isinstance(version, dict) and version.get('version_id') != document_metadata['version_id']
    ]
    versions.append({
        'version_id': document_metadata['version_id'],
        'artifact_path': artifact_rel_path,
        'content_hash': document_metadata['content_hash'],
        'ingested_at': document_metadata['ingested_at'],
        'supersedes_version_id': document_metadata['supersedes_version_id'],
        'summary': document_metadata['summary'],
    })
    return versions

def persist_document_metadata(document_metadata, state_dir, source_index):
    paths = build_state_paths(state_dir, document_metadata['source_id'], document_metadata['version_id'])
    artifact_rel_path = os.path.relpath(paths['artifact'], state_dir)
    write_json_file(paths['artifact'], document_metadata)

    source_index['title'] = document_metadata['title']
    source_index['domain'] = document_metadata['domain']
    source_index['latest_version_id'] = document_metadata['version_id']
    source_index['latest_artifact_path'] = artifact_rel_path
    source_index['last_ingested_at'] = document_metadata['ingested_at']
    source_index['ingest_count'] = int(source_index.get('ingest_count', 0)) + 1
    source_index['versions'] = update_source_versions(source_index.get('versions', []), document_metadata, artifact_rel_path)
    source_index['latest_snapshot'] = build_latest_snapshot(document_metadata)
    write_json_file(paths['source_index'], source_index)

    append_jsonl(paths['ingest_log'], {
        'source_id': document_metadata['source_id'],
        'version_id': document_metadata['version_id'],
        'title': document_metadata['title'],
        'domain': document_metadata['domain'],
        'ingested_at': document_metadata['ingested_at'],
        'supersedes_version_id': document_metadata['supersedes_version_id'],
        'artifact_path': artifact_rel_path,
    })

    return {
        'state_dir': state_dir,
        'source_index_path': os.path.relpath(paths['source_index'], state_dir),
        'artifact_path': artifact_rel_path,
        'ingest_log_path': os.path.relpath(paths['ingest_log'], state_dir),
        'latest_version_id': document_metadata['version_id'],
    }

def parse_markdown_chunks(content):
    lines = content.split('\n')
    chunks = []
    current_heading = "Document Root"
    current_text = []
    
    for line in lines:
        match = re.match(r'^(#{1,6})\s+(.*)', line)
        if match:
            if current_text:
                text_block = '\n'.join(current_text).strip()
                if text_block:
                    chunks.append({
                        "section_heading": current_heading,
                        "text": text_block
                    })
            current_text = []
            current_heading = match.group(2).strip()
        else:
            current_text.append(line)
            
    if current_text:
        text_block = '\n'.join(current_text).strip()
        if text_block:
            chunks.append({
                "section_heading": current_heading,
                "text": text_block
            })
        
    return chunks

def split_sentences(text):
    return [part.strip() for part in SENTENCE_RE.split(text) if part.strip()]

def classify_anchor_kind(text):
    lowered = text.lower()
    if '?' in text:
        return 'open_question'
    if any(token in lowered for token in ['warning', 'confounder', 'failure mode', 'anti-pattern', 'drift']):
        return 'warning'
    if any(token in lowered for token in ['next step', 'experiment', 'falsif', 'measure']):
        return 'open_question'
    if any(token in lowered for token in ['not ', ' but ', 'rather than']):
        return 'reframe'
    return 'thesis'

def extract_anchor_notes(chunks, source_id, version_id, domain):
    anchors = []
    for chunk in chunks:
        candidates = []
        if ANCHOR_RE.search(chunk['text']):
            candidates.append(summarize_text(chunk['text'], 420))
        candidates.extend(line.strip('> ').strip() for line in chunk['text'].splitlines() if line.strip().startswith('>'))

        for candidate in candidates:
            if not candidate:
                continue
            anchor_id = compute_hash(f"{source_id}:{version_id}:{chunk['section_heading']}:{candidate}")[:16]
            anchors.append({
                'anchor_id': anchor_id,
                'kind': classify_anchor_kind(candidate),
                'text': candidate,
                'source_id': source_id,
                'version_id': version_id,
                'source_excerpt_location': chunk['section_heading'],
                'implication': summarize_text(candidate, 160),
                'domain': domain,
                'importance': 3 if ANCHOR_RE.search(candidate) else 2,
                'created_at': utc_now_iso(),
                'superseded_by': None,
            })
            if len(anchors) >= MAX_PROMOTED_OBJECTS:
                return anchors
    return anchors

def extract_claim_notes(chunks, source_id, version_id, domain):
    claims = []
    for chunk in chunks:
        for sentence in split_sentences(chunk['text']):
            if len(sentence) < 24 or not CLAIM_RE.search(sentence):
                continue
            claim_id = compute_hash(f"{source_id}:{version_id}:claim:{sentence}")[:16]
            claims.append({
                'claim_id': claim_id,
                'claim_text': summarize_text(sentence, 360),
                'supporting_context': chunk['section_heading'],
                'implication': summarize_text(sentence, 160),
                'status': 'active',
                'source_id': source_id,
                'version_id': version_id,
                'domain': domain,
            })
            if len(claims) >= MAX_PROMOTED_OBJECTS:
                return claims
    return claims

def parse_correction_context(context):
    denied = re.search(r'denied\s*[:=-]\s*([^.;]+)', context, re.IGNORECASE)
    trigger = re.search(r'(trigger|caused by)\s*[:=-]\s*([^.;]+)', context, re.IGNORECASE)
    corrected = re.search(r'(corrected|revision)\s*[:=-]\s*([^.;]+)', context, re.IGNORECASE)
    return {
        'denied_claim': denied.group(1).strip() if denied else None,
        'revision_trigger': trigger.group(2).strip() if trigger else None,
        'corrected_claim': corrected.group(2).strip() if corrected else None,
    }

def build_correction_event(source_id, version_id, section_heading, context):
    parsed = parse_correction_context(context)
    return {
        'event_id': compute_hash(f"{source_id}:{version_id}:correction:{context}")[:16],
        'source_id': source_id,
        'version_id': version_id,
        'source_excerpt_location': section_heading,
        'evidence': summarize_text(context, 420),
        'denied_claim': parsed['denied_claim'],
        'revision_trigger': parsed['revision_trigger'],
        'corrected_claim': parsed['corrected_claim'],
        'research_value': 'primary_research_data',
    }

def extract_correction_events(chunks, source_id, version_id):
    events = []
    for chunk in chunks:
        lines = chunk['text'].splitlines()
        for index, line in enumerate(lines):
            if not CORRECTION_RE.search(line):
                continue
            context = ' '.join(lines[index:index + 3]).strip()
            events.append(build_correction_event(source_id, version_id, chunk['section_heading'], context))
            if len(events) >= MAX_PROMOTED_OBJECTS:
                return events
    return events

def build_delta_events(source_id, version_id, new_chunks, previous_chunks):
    previous_by_heading = {chunk['section_heading']: chunk for chunk in previous_chunks}
    previous_by_hash = {compute_hash(chunk['text']): chunk for chunk in previous_chunks}
    current_headings = {chunk['section_heading'] for chunk in new_chunks}
    events = []

    for index, chunk in enumerate(new_chunks):
        text_hash = compute_hash(chunk['text'])
        if text_hash in previous_by_hash:
            change_type = 'unchanged'
        elif chunk['section_heading'] in previous_by_heading:
            change_type = 'modified'
        else:
            change_type = 'added'

        events.append({
            'event_id': compute_hash(f"{source_id}:{version_id}:{index}:{change_type}")[:16],
            'source_id': source_id,
            'version_id': version_id,
            'section_heading': chunk['section_heading'],
            'chunk_index': index,
            'change_type': change_type,
            'summary': summarize_text(chunk['text']),
        })

    for previous_chunk in previous_chunks:
        if previous_chunk['section_heading'] not in current_headings:
            events.append({
                'event_id': compute_hash(f"{source_id}:{version_id}:removed:{previous_chunk['section_heading']}")[:16],
                'source_id': source_id,
                'version_id': version_id,
                'section_heading': previous_chunk['section_heading'],
                'chunk_index': None,
                'change_type': 'removed',
                'summary': summarize_text(previous_chunk['text']),
            })

    return events

def build_research_state(claim_notes, anchor_notes, correction_events, chunks):
    active_hypotheses = [claim for claim in claim_notes if re.search(r'\bhypothesis|theory|suggests\b', claim['claim_text'], re.IGNORECASE)]
    confounders = [anchor for anchor in anchor_notes if anchor['kind'] == 'warning']
    questions = []
    for chunk in chunks:
        questions.extend(match.strip() for match in QUESTION_RE.findall(chunk['text']))
    next_experiment = None
    for chunk in chunks:
        for sentence in split_sentences(chunk['text']):
            if re.search(r'\b(next step|experiment|test|measure|falsif)\b', sentence, re.IGNORECASE):
                next_experiment = summarize_text(sentence, 220)
                break
        if next_experiment:
            break

    return {
        'active_hypotheses': active_hypotheses[:MAX_PROMOTED_OBJECTS],
        'confounders': confounders[:MAX_PROMOTED_OBJECTS],
        'open_questions': questions[:MAX_PROMOTED_OBJECTS],
        'correction_events': correction_events,
        'next_discriminating_experiment': next_experiment,
    }

def build_retrieval_profile(domain):
    return {
        'domain': domain,
        'stores': {
            'session_memory': ['continuity_recap', 'correction_event_scan'],
            'durable_memory': ['anchor_note', 'claim_note', 'research_state'],
            'library_documents': ['latest_version_chunks', 'delta_events'],
            'domain_indexes': [domain],
        },
        'routes': {
            'theory_lookup': ['domain_indexes', 'claim_notes', 'latest_version_chunks'],
            'continuity_recap': ['session_memory', 'research_state', 'correction_events'],
            'quote_retrieval': ['anchor_notes'],
            'update_diff_request': ['delta_events', 'morning_summary'],
            'synthesis_request': ['claim_notes', 'anchor_notes', 'research_state', 'latest_version_chunks'],
        },
    }

def build_morning_summary(delta_events, claim_notes, anchor_notes, research_state):
    changed_events = [event for event in delta_events if event['change_type'] != 'unchanged']
    return {
        'summary_id': compute_hash(json.dumps(changed_events, sort_keys=True))[:16],
        'generated_at': utc_now_iso(),
        'date_scope': 'latest_ingest_delta',
        'sources_considered': sorted({event['source_id'] for event in delta_events}),
        'new_claims': [claim['claim_text'] for claim in claim_notes[:5]],
        'updated_claims': [event['summary'] for event in changed_events if event['change_type'] == 'modified'][:5],
        'promoted_anchors': [anchor['text'] for anchor in anchor_notes[:5]],
        'open_questions': research_state['open_questions'][:5],
        'suggested_next_step': research_state['next_discriminating_experiment'],
    }

def build_evaluation_signals(delta_events, anchor_notes, claim_notes, correction_events, research_state):
    changed_count = sum(1 for event in delta_events if event['change_type'] != 'unchanged')
    return {
        'stale_retrieval_risk': 'low' if changed_count else 'medium',
        'repeated_summary_risk': 'low' if changed_count else 'high',
        'contradiction_catch_rate_proxy': len(correction_events),
        'anchor_promotion_count': len(anchor_notes),
        'claim_extraction_count': len(claim_notes),
        'open_question_count': len(research_state['open_questions']),
    }

def build_continuity_cockpit(delta_events, anchor_notes, correction_events, research_state):
    changed_events = [event for event in delta_events if event['change_type'] != 'unchanged']
    return {
        'what_changed': changed_events[:5],
        'promoted_anchors': anchor_notes[:5],
        'corrections_to_review': correction_events[:5],
        'active_tensions': research_state['confounders'][:5],
        'next_action': research_state['next_discriminating_experiment'],
    }

def process_file(file_path, previous_file=None, domain=None, source_id=None, state_dir=None):
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
        
    filename = os.path.basename(file_path)
    source_name = stable_source_name(file_path)
    source_id = source_id or compute_hash(source_name)[:12]
    content_hash = compute_hash(content)
    version_id = compute_hash(f"{source_id}:{content_hash}")[:16]
    inferred_domain = infer_domain(file_path, domain)
    source_index, previous_artifact = load_previous_artifact_from_state(state_dir, source_id, filename, inferred_domain)
    
    new_chunks = parse_markdown_chunks(content)
    previous_chunks = []
    supersedes_version_id = None
    
    if previous_file and os.path.exists(previous_file):
        with open(previous_file, 'r', encoding='utf-8') as pf:
            prev_content = pf.read()
        previous_chunks = parse_markdown_chunks(prev_content)
        supersedes_version_id = compute_hash(f"{source_id}:{compute_hash(prev_content)}")[:16]
    elif previous_artifact:
        previous_chunks = extract_previous_chunks(previous_artifact)
        supersedes_version_id = previous_artifact.get('version_id')
        
    delta_events = build_delta_events(source_id, version_id, new_chunks, previous_chunks)
    events_by_index = {
        event['chunk_index']: event
        for event in delta_events
        if event['chunk_index'] is not None
    }
    chunks = []
    for i, chunk in enumerate(new_chunks):
        event = events_by_index[i]
        chunks.append({
            "chunk_id": f"{source_id}_c{i}",
            "source_id": source_id,
            "version_id": version_id,
            "section_heading": chunk["section_heading"],
            "chunk_index": i,
            "text": chunk["text"],
            "content_hash": compute_hash(chunk["text"]),
            "is_changed": event['change_type'] != 'unchanged',
            "change_type": event['change_type'],
            "domain": inferred_domain,
        })
        
    anchor_notes = extract_anchor_notes(chunks, source_id, version_id, inferred_domain)
    claim_notes = extract_claim_notes(chunks, source_id, version_id, inferred_domain)
    correction_events = extract_correction_events(chunks, source_id, version_id)
    research_state = build_research_state(claim_notes, anchor_notes, correction_events, chunks)
    morning_summary = build_morning_summary(delta_events, claim_notes, anchor_notes, research_state)
    evaluation_signals = build_evaluation_signals(delta_events, anchor_notes, claim_notes, correction_events, research_state)
            
    document_metadata = {
        "source_id": source_id,
        "version_id": version_id,
        "title": filename,
        "domain": inferred_domain,
        "ingested_at": utc_now_iso(),
        "source_path": file_path,
        "supersedes_version_id": supersedes_version_id,
        "content_hash": content_hash,
        "summary": summarize_text(content),
        "chunks": chunks,
        "delta_events": delta_events,
        "anchor_notes": anchor_notes,
        "claim_notes": claim_notes,
        "correction_events": correction_events,
        "research_state": research_state,
        "retrieval_profile": build_retrieval_profile(inferred_domain),
        "morning_summary": morning_summary,
        "evaluation_signals": evaluation_signals,
        "continuity_cockpit": build_continuity_cockpit(delta_events, anchor_notes, correction_events, research_state),
    }

    if state_dir:
        document_metadata['state_store'] = persist_document_metadata(document_metadata, state_dir, source_index)
    
    return document_metadata

def main():
    parser = argparse.ArgumentParser(description="Version-Aware RAG Ingester")
    parser.add_argument("--file", required=True, help="Path to markdown file to ingest")
    parser.add_argument("--previous", help="Path to previous version for diffing")
    parser.add_argument("--domain", help="Optional domain override for retrieval routing")
    parser.add_argument("--source-id", help="Optional stable source id override")
    parser.add_argument("--state-dir", help="Optional directory for persistent continuity artifacts")
    parser.add_argument("--output-mode", choices=["auto", "full", "compact"], default="auto", help="Choose full or compact JSON output")
    
    args = parser.parse_args()
    
    if not os.path.exists(args.file):
        print(json.dumps({"error": "File not found"}))
        return
        
    result = process_file(args.file, args.previous, args.domain, args.source_id, args.state_dir)
    print(json.dumps(format_output(result, determine_output_mode(args.output_mode, args.state_dir)), indent=2))

if __name__ == "__main__":
    main()
