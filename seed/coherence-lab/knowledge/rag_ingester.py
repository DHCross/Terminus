#!/usr/bin/env python3
import json
import argparse
import hashlib
import os
import re

def compute_hash(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()

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

def process_file(file_path, previous_file=None):
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
        
    filename = os.path.basename(file_path)
    source_id = compute_hash(filename)[:12]
    content_hash = compute_hash(content)
    
    new_chunks = parse_markdown_chunks(content)
    
    changes = []
    if previous_file and os.path.exists(previous_file):
        with open(previous_file, 'r', encoding='utf-8') as pf:
            prev_content = pf.read()
        prev_chunks = parse_markdown_chunks(prev_content)
        
        prev_texts = {c["text"]: c for c in prev_chunks}
        
        for i, chunk in enumerate(new_chunks):
            chunk_data = {
                "chunk_id": f"{source_id}_c{i}",
                "source_id": source_id,
                "section_heading": chunk["section_heading"],
                "chunk_index": i,
                "text": chunk["text"],
                "content_hash": compute_hash(chunk["text"])
            }
            if chunk["text"] in prev_texts:
                chunk_data["is_changed"] = False
                chunk_data["change_type"] = "unchanged"
            else:
                chunk_data["is_changed"] = True
                chunk_data["change_type"] = "modified" if chunk["section_heading"] in [c["section_heading"] for c in prev_chunks] else "added"
            changes.append(chunk_data)
    else:
        for i, chunk in enumerate(new_chunks):
            changes.append({
                "chunk_id": f"{source_id}_c{i}",
                "source_id": source_id,
                "section_heading": chunk["section_heading"],
                "chunk_index": i,
                "text": chunk["text"],
                "content_hash": compute_hash(chunk["text"]),
                "is_changed": True,
                "change_type": "added"
            })
            
    document_metadata = {
        "source_id": source_id,
        "title": filename,
        "source_path": file_path,
        "content_hash": content_hash,
        "chunks": changes
    }
    
    return document_metadata

def main():
    parser = argparse.ArgumentParser(description="Version-Aware RAG Ingester")
    parser.add_argument("--file", required=True, help="Path to markdown file to ingest")
    parser.add_argument("--previous", help="Path to previous version for diffing")
    
    args = parser.parse_args()
    
    if not os.path.exists(args.file):
        print(json.dumps({"error": "File not found"}))
        return
        
    result = process_file(args.file, args.previous)
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
