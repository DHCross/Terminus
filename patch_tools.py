import json
import sys

path = '/Volumes/My Passport/Sapphire-native/user/plugins/sherlog/tools/sherlog_tools.py'

with open(path, 'r') as f:
    lines = f.readlines()

new_lines = []
in_coherence = False
for line in lines:
    if line.startswith("def sherlog_check_coherence"):
        in_coherence = True
        new_lines.append(line)
        new_lines.append('''    """
    Evaluates the agent's recent internal state and decisions for drift or contradictions.
    This reads actual trace files from the continuity directory.
    """
    import json
    trace_dir = _trace_dir()
    if not trace_dir.exists():
        return "Sherlog status: Active. No traces found yet to analyze."
    
    try:
        traces = sorted(list(trace_dir.glob("*.jsonl")), reverse=True)
        if not traces:
            return "Sherlog status: Active. Traces directory exists but is empty."
        
        recent_log = traces[0]
        entries = []
        with open(recent_log, 'r') as f:
            for log_line in f:
                try:
                    entries.append(json.loads(log_line.strip()))
                except:
                    pass
                    
        # Filter if there's a query
        if query:
            entries = [e for e in entries if query.lower() in str(e).lower()]
            
        if not entries:
            return f"Sherlog analysis: Scanned {recent_log.name}. No trace entries matched query '{query}'."
            
        # Return tail of traces to fit within context
        output = [f"[{e.get('ts', '')}] {e.get('type', 'log')}: {e.get('text', '')[:500]}" for e in entries[-20:]]
        
        return f"Sherlog returned {len(output)} recent relevant trace objects from {recent_log.name}:\\n" + "\\n".join(output)
        
    except Exception as e:
        return f"Sherlog error during coherence check: {str(e)}"
''')
    elif in_coherence and line.startswith("def sherlog_self_audit"):
        in_coherence = False
        new_lines.append(line)
    elif not in_coherence:
        new_lines.append(line)

with open(path, 'w') as f:
    f.writelines(new_lines)

print("Tool patched.")
