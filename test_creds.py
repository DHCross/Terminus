import sys
import os
sys.path.append("/Volumes/My Passport/Sapphire-native")

from core.credentials_manager import credentials

print("has claude:", credentials.has_stored_api_key('claude'))
print("claude key:", credentials.get_llm_api_key('claude')[:10] + '...')
