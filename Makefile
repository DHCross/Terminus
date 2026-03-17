.PHONY: launch stop logs setup seed-coherence-lab verify doctor gaps hygiene

# Resolve Sapphire-native directory from .env or use default
SAPPHIRE_NATIVE_DIR ?= $(shell grep -E '^SAPPHIRE_NATIVE_DIR=' .env 2>/dev/null | cut -d= -f2- || echo "/Volumes/My Passport/Sapphire-native")
ifeq ($(SAPPHIRE_NATIVE_DIR),)
  SAPPHIRE_NATIVE_DIR = /Volumes/My Passport/Sapphire-native
endif

launch:
	cd "$(SAPPHIRE_NATIVE_DIR)" && task launch

stop:
	cd "$(SAPPHIRE_NATIVE_DIR)" && task kill

logs:
	tail -f /tmp/sapphire-electron.log /tmp/sapphire-native.log 2>/dev/null || echo "No log files found yet. Start Sapphire first with: make launch"

setup:
	./scripts/setup-native.sh

seed-coherence-lab:
	./scripts/install-coherence-lab.sh

# SHERLOG preflight
NODE ?= $(shell command -v node 2>/dev/null || echo /usr/local/bin/node)

verify:
	$(NODE) sherlog-velocity/src/cli/verify.js

doctor:
	$(NODE) sherlog-velocity/src/cli/doctor.js $(ARGS)

gaps:
	$(NODE) sherlog-velocity/src/cli/gaps.js $(ARGS)

hygiene:
	$(NODE) sherlog-velocity/src/cli/hygiene.js $(ARGS)
