# Agent Voice Constitution

<!--
SYNC IMPACT REPORT
==================
Version Change: INITIAL → 1.0.0 (MAJOR - initial ratification)
Modified Principles: N/A (initial creation)
Added Sections: All core sections established
Removed Sections: None
Templates Requiring Updates:
  ✅ .specify/templates/plan-template.md - Constitution Check section verified
  ✅ .specify/templates/spec-template.md - Requirements alignment verified
  ✅ .specify/templates/tasks-template.md - Task structure verified
  ✅ .specify/templates/commands/*.md - Reviewed for consistency
Follow-up TODOs: None
-->

## Core Principles

### I. Simplicity First (YAGNI)

You Aren't Gonna Need It (YAGNI) is non-negotiable. Implement only what is required for the current user story. Do not build frameworks, abstractions, or "future-proof" solutions based on speculation. Simple, direct solutions beat clever architectures. Over-engineering is a defect, not a feature.

**Rationale**: VS Code extensions must start quickly and consume minimal resources. Every abstraction layer adds cognitive load, bundle size, and initialization overhead. The TypeScript module system and service injection already provide sufficient structure—additional patterns must justify their complexity with concrete, present-tense requirements.

### II. Modular Design (SOLID)

Every module, class, and function has one reason to change. Follow SOLID principles:

- **Single Responsibility**: Each service handles one concern (auth, audio, session, etc.)
- **Open/Closed**: Extend behavior through composition and dependency injection, not modification
- **Liskov Substitution**: Implementations of `ServiceInitializable` must be interchangeable
- **Interface Segregation**: Clients depend only on interfaces they use (e.g., separate telemetry observers from core services)
- **Dependency Inversion**: High-level modules depend on abstractions (`IConfigurationManager`), not concrete classes

**Rationale**: The extension orchestrates Azure AI, VS Code APIs, WebRTC, and GitHub Copilot. Coupling these domains tightly creates brittle, untestable code. Service-based architecture with dependency injection enables isolated testing, gradual migration, and clean error boundaries.

### III. Don't Repeat Yourself (DRY)

Duplication is a maintenance hazard. Extract shared logic into focused utilities, but only after the pattern emerges in at least three places. Premature abstraction is as harmful as duplication—wait for concrete reuse before consolidating.

**Rationale**: VS Code extension APIs, Azure SDK patterns, and TypeScript error handling recur throughout the codebase. Centralizing these patterns in `core/`, `config/validators/`, and `services/` ensures consistent behavior (retries, logging, credential handling) and reduces the surface area for bugs.

### IV. Test Pyramid (Unit-First)

Testing follows the pyramid model: **many fast unit tests**, **some integration tests**, **few UX tests**.

- **Unit Tests (majority)**: Test services, utilities, and domain logic in isolation using fakes/stubs. Target: >90% statement coverage, >85% branch coverage, <100ms per suite.
- **Integration Tests (selective)**: Verify VS Code API integration, webview messaging, and configuration lifecycle. Run via `@vscode/test-electron`. Target: Happy paths + critical error scenarios.
- **UX Tests (minimal)**: Validate end-to-end voice session flows only when integration tests cannot verify the full chain (e.g., WebRTC negotiation with Azure, Copilot Chat interop). Keep under 10 scenarios.

**Rationale**: Unit tests provide instant feedback in the inner dev loop and enable confident refactoring. Integration tests catch VS Code-specific edge cases (extension host lifecycle, webview disposal). UX tests are slow and brittle—reserve them for workflows that span multiple external systems where mocking hides real bugs.

### V. Fast Developer Inner Loop

Changes must be verifiable within 10 seconds:

- **Type Checking**: `npm run watch:tsc` and `watch:tsc-test` provide instant TypeScript error feedback without compilation overhead
- **Bundling**: `npm run watch:webpack` rebuilds extension bundle incrementally
- **Unit Tests**: Run targeted suites via `npm run test:unit` or VS Code "Test Unit" task
- **Linting**: `npm run lint` enforces code quality before integration tests

**Rationale**: Slow feedback loops kill productivity. Separating type checking from bundling (watch mode runs both in parallel) surfaces errors immediately while webpack handles hot recompilation. Fast unit tests mean developers never wait more than 2-3 seconds to know if a change broke something.

### VI. Documentation-Driven Development

Code is documentation's first reader. Write:

- **JSDoc**: Public APIs, non-obvious intent, edge cases. Include `@remarks` for design rationale and `@example` for usage patterns.
- **README**: Quickstart, architecture overview, troubleshooting
- **Technical Specs**: Architecture decisions in `docs/design/`, feature specs in `spec/`
- **Inline Comments**: Capture "why" (intent, constraints, trade-offs), never "what" (the code already shows this)

**Rationale**: Agent Voice integrates four complex systems (VS Code extensions, Azure OpenAI Realtime, WebRTC, GitHub Copilot). Undocumented assumptions—like why ephemeral keys exist or when to use WebSocket fallback—create knowledge silos. Comments age slower than external docs because reviewers see them during changes.

### VII. CLEANCODE Discipline

Follow Uncle Bob's principles:

- **Meaningful Names**: Variables, functions, and classes express intent without abbreviations or jargon
- **Small Functions**: <20 lines, one level of abstraction, clear purpose
- **Error Handling**: Use typed errors (`AgentVoiceError`), early returns, structured logging—never silent failures
- **No Side Effects**: Pure functions where possible; isolate mutations behind clear boundaries
- **Avoid Magic Numbers**: Constants with semantic names (`CONNECTION_TIMEOUT_MS`, not `5000`)

**Rationale**: The extension lives in a complex runtime (VS Code extension host + Node.js + WebRTC + Azure). Unclear code multiplies debugging time exponentially. Small, focused functions enable unit testing without mocks; typed errors enable recovery orchestration; pure functions simplify reasoning.

### VIII. Maintainability Over Cleverness

Choose boring, obvious solutions. TypeScript's type system and VS Code's APIs already provide powerful abstractions—use them directly before adding custom frameworks. Composition beats inheritance. Explicit beats implicit. Readability beats brevity.

**Rationale**: The extension must remain maintainable as Azure OpenAI APIs evolve, VS Code releases new versions, and GitHub Copilot changes integration contracts. Clever patterns (metaprogramming, complex generics, DSLs) create technical debt that compounds during migrations. Straightforward code survives churn.

### IX. Modern Practices, Latest Packages

Use current tooling and dependencies:

- **TypeScript 5.x**: Latest language features (satisfies operator, const type parameters)
- **ES2022 Target**: Native async/await, optional chaining, nullish coalescing
- **Latest Azure SDKs**: `@azure/identity`, `openai` SDK (Azure-compatible), current API versions
- **Dependency Updates**: Run `npm outdated` monthly; patch security advisories within 48 hours

**Rationale**: Outdated dependencies accumulate security vulnerabilities and miss performance improvements. TypeScript 5 + ES2022 eliminate polyfills and reduce bundle size. Azure SDK versions unlock new capabilities (ephemeral keys, WebRTC transport) that simplify implementation.

### X. Verify First, Never Assume

Before implementing or refactoring:

- **Check Documentation**: Use `#context7` for package samples, read Azure OpenAI API specs, review VS Code API docs
- **Verify Existing Code**: Search with `grep_search`, `semantic_search`, or `list_code_usages` to understand current patterns
- **Ask for Confirmation**: If requirements are ambiguous, propose options and wait for user decision

**Rationale**: Assumptions lead to rework. The extension integrates rapidly evolving APIs (Azure OpenAI Realtime API is in preview). Verifying API contracts, configuration schemas, and existing patterns before coding prevents incompatible changes and reduces PR cycle time.

## Constraints & Standards

### Language & Tooling

- **TypeScript 5**: Strict mode enabled, ES module syntax, compiled to CommonJS for VS Code compatibility
- **Code Quality**: ESLint (flat config) is authoritative; zero warnings before merge
- **Testing**: Mocha + Chai (BDD style), NYC for coverage, `@vscode/test-electron` for integration
- **Bundling**: Webpack for extension bundle, source maps enabled
- **Formatting**: Run `npm run format` (Prettier) before committing

### Architecture Patterns

- **Service Lifecycle**: All services implement `ServiceInitializable` (initialize/dispose/isInitialized)
- **Error Handling**: Use `ErrorEventBusImpl`, `RecoveryOrchestrator`, typed `AgentVoiceError` envelopes
- **Configuration**: Centralized via `ConfigurationManager`, validated with dedicated validators
- **Secrets**: Store in VS Code `SecretStorage` via `CredentialManagerImpl`—never disk or logs
- **Async**: Async/await everywhere, wrap in try/catch with structured error emission

### Security Requirements

- **Authentication**: Default to `DefaultAzureCredential` (keyless auth); ephemeral keys only for WebRTC startup
- **Input Validation**: Sanitize user content before persistence, telemetry, or webview rendering
- **Secret Storage**: Use `vscode.SecretStorage`, rotate ephemeral keys per session
- **Dependency Audits**: `npm audit` in CI, fail build on high/critical vulnerabilities
- **CSP**: Webview content security policy enforced (`media/sanitize-html.js`)

### Performance Standards

- **Extension Activation**: <500ms from `activate()` call to UI ready (lazy-load Azure clients)
- **Audio Latency**: <200ms from user speech to transcription display (WebRTC preferred over WebSocket)
- **Memory**: <100MB baseline, <300MB during active conversation (dispose sessions promptly)
- **Bundle Size**: <2MB extension bundle (tree-shake unused dependencies)

## Development Workflow

### Pre-Implementation

1. **Read Specification**: Understand user stories, acceptance criteria, technical context
2. **Review Constitution**: Ensure approach aligns with principles (simple, modular, testable)
3. **Plan Tasks**: Break into independently testable units, prioritize P1 stories
4. **Write Tests First**: Red-Green-Refactor cycle (tests fail → implement → tests pass → refactor)

### Implementation Standards

- **One Concern Per Commit**: Feature, test, refactor—not mixed
- **Branch Naming**: `###-feature-name` matching issue number
- **PR Checklist**: Lint passes, tests green (unit + integration), coverage thresholds met (90/85/90/90), docs updated

### Quality Gates

All PRs must pass:

- **Lint**: `npm run lint` (zero errors or warnings)
- **Type Checking**: `npm run watch:tsc` and `watch:tsc-test` (no TypeScript errors)
- **Unit Tests**: `npm run test:unit` (>90% statement coverage)
- **Integration Tests**: `npm run test:extension` (happy paths + critical errors)
- **Coverage**: `npm run test:coverage` (NYC thresholds: 90/85/90/90)
- **Performance**: `npm run test:perf` (regression checks vs baseline)

### Testing Guidelines

- **Unit Tests**: Use fakes/stubs for VS Code APIs, Azure clients, timers. Target: <100ms per suite, deterministic results.
- **Integration Tests**: Launch VS Code extension host, verify command registration, webview lifecycle, configuration changes. Target: <5s per test.
- **UX Tests**: Headless mode via `npm run test:headless` (xvfb in CI). Only for end-to-end voice session flows.
- **Test Structure**: Mocha suites prefixed `Unit:` or `Integration:`, Chai assertions in BDD style, `before`/`after` hooks for setup, `afterEach` for cleanup.

### Documentation Maintenance

- **JSDoc**: Update when signatures or behaviors change
- **Technical Specs**: Create new specs in `spec/` for features, update `docs/design/` for architecture changes
- **README/Quickstart**: Keep installation, setup, and troubleshooting current
- **CHANGELOG**: Document all user-facing changes per release

## Governance

### Amendment Process

1. **Proposal**: Submit PR with rationale for principle change, addition, or removal
2. **Impact Analysis**: Identify affected specs, templates, code patterns
3. **Review**: Team consensus required (async review window: 3 business days)
4. **Migration Plan**: Document backward compatibility, deprecated patterns, timeline
5. **Ratification**: Merge to main, update version per semantic versioning

### Versioning Policy

Constitution follows semantic versioning:

- **MAJOR (X.0.0)**: Backward-incompatible principle removal or redefinition (requires migration guide)
- **MINOR (0.X.0)**: New principle or material expansion (update templates, may require code changes)
- **PATCH (0.0.X)**: Clarifications, wording fixes, non-semantic improvements (no code changes)

### Compliance Review

- **PR Review**: Check one principle per PR comment when violations observed
- **Quarterly Audit**: Review codebase for drift, update constitution if patterns have legitimately evolved
- **Complexity Budget**: Justify any violation in PR description with concrete trade-offs (performance, security, external constraints)

### Authority

This constitution supersedes informal practices, past conventions, and individual preferences. When the constitution conflicts with external guidance (framework docs, style guides), the constitution wins unless a principle violation is formally justified and approved.

### Guidance Files

Runtime development guidance lives in:

- **AGENTS.md**: Primary agent development guide (architecture, patterns, workflows)
- **.github/instructions/typescript-5-es2022.instructions.md**: TypeScript-specific coding standards
- **.github/instructions/markdown.instructions.md**: Documentation standards

When conflicts arise, resolution order: Constitution → AGENTS.md → language-specific instructions.

**Version**: 1.0.0 | **Ratified**: 2025-12-05 | **Last Amended**: 2025-12-05
