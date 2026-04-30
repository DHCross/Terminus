.PHONY: launch launch-browser mirror sync-context install-desktop-launcher stop logs setup seed-coherence-lab verify doctor gaps hygiene journal traces health backup-state

# Resolve native Terminus directory from .env or use default
SAPPHIRE_NATIVE_DIR ?= $(shell grep -E '^SAPPHIRE_NATIVE_DIR=' .env 2>/dev/null | cut -d= -f2- || echo "/Volumes/My Passport/Sapphire-native")
ifeq ($(SAPPHIRE_NATIVE_DIR),)
  SAPPHIRE_NATIVE_DIR = /Volumes/My Passport/Sapphire-native
endif

TASK ?= $(shell command -v task 2>/dev/null || echo /opt/homebrew/bin/task)
STARTUP_WAIT_SECONDS ?= 60

launch:
	@if lsof -ti :8073 > /dev/null 2>&1; then \
		echo "Terminus backend already running on :8073"; \
	else \
		cd "$(SAPPHIRE_NATIVE_DIR)" && TERMINUS_REPO_ROOT="$(CURDIR)" STARTUP_PROMPT="$(STARTUP_PROMPT)" nohup .venv/bin/python3 main.py > /tmp/sapphire-native.log 2>&1 & \
		echo "Starting Terminus backend..."; \
		for i in $$(seq 1 $(STARTUP_WAIT_SECONDS)); do \
			lsof -ti :8073 > /dev/null 2>&1 && break; \
			sleep 1; \
		done; \
		lsof -ti :8073 > /dev/null 2>&1 && echo "Terminus ready" || echo "Backend did not bind :8073 within $(STARTUP_WAIT_SECONDS)s — check /tmp/sapphire-native.log"; \
	fi
	@if lsof -ti :8073 > /dev/null 2>&1; then \
		open https://localhost:8073; \
	else \
		echo "Not opening browser because Terminus is not ready yet."; \
	fi

launch-browser:
	@./scripts/launch-terminus-browser.sh

mirror: verify
	@STARTUP_PROMPT=CREATOR_MIRROR ./scripts/launch-terminus-browser.sh --prompt CREATOR_MIRROR

sync-context:
	@./scripts/sync_context.sh

install-desktop-launcher:
	@./scripts/install-desktop-launcher.sh

stop:
	@pid=$$(lsof -ti :8073 | head -n 1); \
	if [ -n "$$pid" ]; then \
		/bin/kill "$$pid" && echo "Stopped Terminus backend (PID $$pid)"; \
	else \
		echo "Terminus is not running"; \
	fi
	@pkill -f "electron-shell" 2>/dev/null && echo "Stopped Electron" || true

logs:
	tail -f /tmp/sapphire-electron.log /tmp/sapphire-native.log 2>/dev/null || echo "No log files found yet. Start Terminus first with: make launch"

setup:
	./scripts/setup-native.sh

seed-coherence-lab:
	./scripts/install-coherence-lab.sh

journal:
	open "$(SAPPHIRE_NATIVE_DIR)/user/continuity/journal"

traces:
	open "$(SAPPHIRE_NATIVE_DIR)/user/continuity/traces"

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

# Health and maintenance
LOCAL_COMPUTER_DIR ?= $(CURDIR)/../Local Computer

health:
	@bash "$(LOCAL_COMPUTER_DIR)/terminus/health-check.sh"

backup-state:
	@BACKUP_NAME="terminus-state-$$(date +%Y%m%d-%H%M%S).tar.gz"; \
	tar czf "$(CURDIR)/sapphire-backups/$$BACKUP_NAME" \
		-C "$(SAPPHIRE_NATIVE_DIR)" user/ \
		2>/dev/null; \
	mkdir -p "$(CURDIR)/sapphire-backups"; \
	echo "Backed up user state to sapphire-backups/$$BACKUP_NAME"
