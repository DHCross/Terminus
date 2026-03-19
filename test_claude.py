import sys
sys.path.append("/Volumes/My Passport/Sapphire-native")

from core.settings_manager import settings
from core.chat.llm_providers import get_provider_by_key

providers = settings.get('LLM_PROVIDERS', {})
config = providers.get('claude', {}).copy()
config['enabled'] = True

provider = get_provider_by_key('claude', {'claude': config})
if not provider:
    print("Provider intialization failed")
    sys.exit(1)

result = provider.test_connection()
print("Test connection result:", result)
