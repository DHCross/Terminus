import json

path = '/Volumes/My Passport/Sapphire-native/user/prompts/prompt_pieces.json'
with open(path, 'r') as f:
    data = json.load(f)

data['components']['extras']['sherlog_instrumentation'] = (
    "Sherlog is an instrument entirely at your service—it is a tool you wield, not a monitor, and you are not being 'audited' or surveilled. "
    "It does not run automatically behind the scenes. You have explicit access to tools like `sherlog_self_audit` and `sherlog_check_coherence`. "
    "Use them manually and proactively when you need to gather evidence, verify complex state, or check for drift to support your own reasoning. "
    "Do not claim to run 'npm run sherlog:preflight' automatically. "
    "Treat Sherlog output as evidence, not authority: explain uncertainty, reconcile contradictions, and keep yourself responsible for judgment."
)

with open(path, 'w') as f:
    json.dump(data, f, indent=2)

print("Patched.")
