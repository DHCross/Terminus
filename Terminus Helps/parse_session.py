import json
import sys
import os
from datetime import datetime

def parse_session(json_path):
    with open(json_path, 'r') as f:
        data = json.load(f)

    session_id = data.get('session', {}).get('id', 'Unknown Session')
    out_lines = []
    out_lines.append(f"# Raven Session Debug Summary: {session_id}")
    out_lines.append(f"**Exported At:** {data.get('metadata', {}).get('exportedAt', 'N/A')}")
    out_lines.append(f"**Final Phase:** {data.get('session', {}).get('phase', 'N/A')} | **Turns:** {data.get('session', {}).get('turnCount', 'N/A')}")
    out_lines.append("---\n## Runtime Events (Chronological)")

    events = data.get('runtimeEvents', [])
    for ev in events:
        ts = ev.get('timestamp', '')[11:19] # just get time HH:MM:SS
        ev_type = ev.get('type', 'UNKNOWN')
        payload = ev.get('payload', {})
        
        detail = ""
        if 'module' in payload:
            detail += f" Module: {payload['module']}"
        if 'reason' in payload:
            detail += f" Reason: {payload['reason']}"
        if 'turnClass' in payload:
            detail += f" TurnClass: {payload['turnClass']}"
        if 'status' in payload:
            detail += f" Status: {payload['status']}"
        if 'detail' in payload:
            detail += f" Detail: {payload['detail']}"
            
        out_lines.append(f"- `[{ts}]` **{ev_type}**{detail}")
        
    out_lines.append("\n---\n## Chat History & Diagnostics")
    messages = data.get('messages', [])
    for msg in messages:
        role = msg.get('role', 'unknown').upper()
        text = msg.get('text', '').strip()
        ts = msg.get('timestamp', '')[11:19]
        
        out_lines.append(f"\n### {role} `[{ts}]`")
        out_lines.append(f"> {text[:200]}..." if len(text) > 200 else f"> {text}")
        
        corridor = msg.get('corridorSnapshot')
        if corridor:
            if 'relationalFallback' in corridor:
                fallback = corridor['relationalFallback']
                out_lines.append(f"\n*⚠️ Relational Fallback Triggered:* Mode: **{fallback.get('mode')}** | Status: **{fallback.get('status')}**")
            
        bt = msg.get('balanceTag')
        if bt:
            out_lines.append(f"\n*Balance Tag:* Mag: {bt.get('magnitude')} | Bias: {bt.get('bias')} | Tier: {bt.get('tierLabel')} | Coherent: {bt.get('isCoherent')}")

    out_text = '\n'.join(out_lines)
    
    base_name = os.path.splitext(os.path.basename(json_path))[0]
    out_path = os.path.join(os.path.dirname(json_path), f"{base_name}-summary.md")
    
    with open(out_path, 'w') as f:
        f.write(out_text)
        
    print(f"Successfully wrote summary to: {out_path}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python parse_session.py <path_to_session.json>")
        sys.exit(1)
    parse_session(sys.argv[1])
