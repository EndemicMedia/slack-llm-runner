# Contributing to Slack CLI Wrapper

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [Commit Message Guidelines](#commit-message-guidelines)

## Getting Started

### Prerequisites

- Node.js 20+ (use `nvm install` if you have nvm)
- npm or yarn
- Git

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/slack-cli-wrapper.git
   cd slack-cli-wrapper
   ```

3. Add the upstream remote:
   ```bash
   git remote add upstream https://github.com/ORIGINAL_OWNER/slack-cli-wrapper.git
   ```

## Development Setup

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your test Slack app credentials

# Run in development mode
npm run dev

# Run tests
npm test
```

### Project Structure Overview

```
src/
├── cli/          # PTY spawn and session management
├── commands/     # Command parsing and routing
├── streaming/    # Output handling (envelopes, streaming)
├── scheduler/    # Cron job scheduling
├── security/     # Authorization and filtering
├── slack/        # Slack integration (Bolt)
└── utils/        # Utilities (config, logger)
```

## Coding Standards

### TypeScript

- Use TypeScript with strict mode enabled
- Define explicit return types for public functions
- Use interfaces for object shapes
- Avoid `any` type - use `unknown` when necessary

```typescript
// Good
interface SessionConfig {
  id: string;
  timeout: number;
}

function createSession(config: SessionConfig): Session {
  // implementation
}

// Avoid
function createSession(config: any) {
  // implementation
}
```

### File Naming

- Source files: `camelCase.ts`
- Test files: `kebab-case.test.ts`
- Config files: `kebab-case.yaml`

### Code Style

- 2 spaces for indentation
- Max line length: 100 characters
- Use single quotes for strings
- Trailing commas in multi-line objects/arrays

```typescript
// Good
const config = {
  name: 'test',
  timeout: 30,
  retries: 3,
};

// Avoid
const config = {
  name: "test",
  timeout: 30
};
```

### Comments

- Use JSDoc for public APIs
- Explain "why", not "what" (the code shows what)
- Keep comments current with code changes

```typescript
/**
 * Spawns a CLI process with PTY support.
 * 
 * PTY is required for interactive CLIs like Claude Code that
 * check for TTY and change behavior (colors, prompts) accordingly.
 * 
 * @param binary - Path to the executable
 * @param args - Command arguments
 * @param options - Spawn options including mode (interactive|one-shot)
 * @returns SpawnHandle for managing the process
 */
export async function spawnProcess(
  binary: string,
  args: string[],
  options: SpawnOptions
): Promise<SpawnHandle> {
  // implementation
}
```

## Testing

### Test Organization

```
tests/
├── unit/           # Unit tests (isolated components)
├── integration/    # Integration tests (multiple components)
└── e2e/            # End-to-end tests (full workflows)
```

### Writing Tests

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Feature Name', () => {
  it('should do something specific', async () => {
    // Arrange
    const input = 'test';
    
    // Act
    const result = await functionUnderTest(input);
    
    // Assert
    assert.strictEqual(result, 'expected');
  });
  
  it('should handle edge case', async () => {
    // Test edge cases
  });
});
```

### Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e

# Specific test file
node --import tsx --test tests/unit/cli/process-handle.test.ts
```

### Test Coverage

Aim for:
- 80%+ coverage for core functionality
- 100% coverage for security-critical code
- Tests for error paths, not just happy paths

## Submitting Changes

### Branch Naming

Use descriptive branch names:

```
feature/add-webhook-support
bugfix/fix-session-timeout
docs/update-readme
refactor/simplify-router
```

### Pull Request Process

1. **Create a feature branch** from `master`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** with clear, focused commits

3. **Test your changes**:
   ```bash
   npm test
   npm run typecheck
   ```

4. **Update documentation** if needed:
   - README.md for user-facing changes
   - docs/ for detailed documentation
   - CHANGELOG.md for significant changes

5. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

6. **Open a Pull Request** with:
   - Clear title and description
   - Reference any related issues
   - Screenshots/GIFs for UI changes
   - Test results

### PR Review Process

- All PRs require at least one review
- Address review feedback promptly
- Keep PRs focused and reasonably sized
- Rebase on master if there are conflicts

## Commit Message Guidelines

Use conventional commits format:

```
type(scope): subject

body (optional)

footer (optional)
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Build process, dependencies, etc.

### Examples

```
feat(cli): add support for custom shells

fix(output): handle envelope markers split across chunks

docs(readme): update installation instructions

test(session): add tests for concurrent sessions

refactor(router): simplify output routing logic
```

### Subject Guidelines

- Use imperative mood: "add" not "added" or "adds"
- Don't capitalize first letter
- No period at the end
- Keep under 72 characters

## Questions?

- Open an issue for bugs or feature requests
- Start a discussion for questions or ideas
- Join our Slack channel (if available)

Thank you for contributing! 🎉
