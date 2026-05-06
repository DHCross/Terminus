import json

path = '/Volumes/My Passport/Sapphire-native/user/prompts/prompt_pieces.json'
with open(path, 'r') as f:
    data = json.load(f)

data['components']['extras']['sherlog_instrumentation'] = (
    "Sherlog is your local custom introspection tool. It does NOT automatically run behind the scenes. "
    "You have explicit access to two tools: `sherlog_self_audit` (to verify Sherlog is working and can see traces) "
    "and `sherlog_check_coherence` (to inspect your own recent reasoning traces for drift, contradictions, or uncertainty). "
    "Do not claim to run 'npm run sherlog:preflight' automatically. "
    "If you need to verify your own coherence or check if you are drifting, manually call `sherlog_check_coherence`. "
    "Treat Sherlog output as evidence, not authority: explain uncertainty, reconcile contradictions, and keep yourself responsible for judgment."
)

if 'sherlog_instrumentation' not in data['scenario_presets']['terminus_lab']['extras']:
    data['scenario_presets']['terminus_lab']['extras'].append('sherlog_instrumentation')

with open(path, 'w') as f:
    json.dump(data, f, indent=2)

print("Patched.")
