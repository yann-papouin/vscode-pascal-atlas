# Pascal Atlas project instructions

These instructions apply throughout this repository. Follow any additional instructions
in nested `AGENTS.md` files for their directories.

## Project and layout

Pascal Atlas is a desktop VS Code extension for Pascal/Delphi workspaces. It provides
project and class navigation, source and compiled-package indexing, completion,
syntax/compiler diagnostics, formatting, and optional AI routine steps.

- `package.json` defines the supported VS Code version, extension contributions,
  dependencies, and npm commands. The current minimum is `^1.140.0`; keep
  `@types/vscode` and documented requirements aligned with the manifest.
- `src/extension.ts` is the host entrypoint. Keep VS Code integration here or in the
  existing feature modules.
- `src/classNavigator.ts`, `src/implementationCore.ts`, and `src/aiSteps.ts` implement
  navigation, routine counterpart generation, and AI step planning.
- `src/binarySymbols.ts` and `src/usesQuickFix.ts` handle compiled/source symbols, type
  inference, navigation candidates, and uses insertion.
- `src/formatter/` contains formatting, postprocessing, generic-type handling, and
  keyword highlighting.
- `src/shared/` contains named models, protocol guards, and domain constants. Reuse
  these definitions before creating new ones.
- `src/webview/` contains the navigator and control-center browser clients. Their host
  HTML and provider code live in `src/classNavigatorWebview.ts` and
  `src/controlCenter.ts`.
- `resources/` and `media/` contain declarative grammars, snippets, formatter
  configuration, fonts, and icons.
- `test/` contains Node regression tests, worker integration tests, browser harnesses,
  and an isolated Extension Development Host smoke test.

## TypeScript and module boundaries

- Add JSDoc docstrings to every function and method in `src/`, including internal
  helpers. Explain purpose and non-obvious parameters, return values, side effects, or
  failure conditions without repeating obvious TypeScript annotations.
- Add inline comments for non-trivial logic. Explain intent, constraints, and why an
  approach is needed rather than narrating obvious statements.
- Write authored code and tests in TypeScript. Maintain `strict` and `noEmitOnError`; do
  not introduce `any`, `@ts-nocheck`, or checking suppressions to make a build pass.
- Use named interfaces and discriminated unions for domain models and messages. Treat
  JSON, persisted caches, worker/webview messages, and caught exceptions as `unknown`
  until narrowed with appropriate guards.
- Prefer contextual callback inference and small interfaces for injected APIs/test
  doubles. Avoid broad assertions that bypass a real interface mismatch.
- Host modules and tests compile with Node16 module resolution and CommonJS output.
  Browser clients use the separate DOM-oriented configuration and esbuild bundles.
- Shared runtime constants and protocols must stay usable in Node workers and browser
  clients. Keep Node and VS Code runtime imports out of these shared boundaries; use
  type-only imports where applicable.
- Worker dependency graphs must load without the `vscode` runtime module. Preserve
  existing lazy host bindings and type-only imports when refactoring navigation or
  indexing code.

## Constants and Pascal behavior

- Centralize repeated domain values in the appropriate existing registry: Pascal
  vocabulary/directives, intrinsic and built-in names, language IDs, commands,
  setting/state keys, symbol kinds, worker operations/events, webview message kinds, and
  resource paths.
- Keep concepts separate even when their values match. A worker `message` event, a URI
  `file` scheme, or a navigator `class` mode is not a Pascal keyword.
- Preserve each feature's keyword membership and case rules. Contextual visibility words
  can also be valid identifiers; escaped and qualified names must retain their symbol
  behavior.
- When extracting regex vocabulary, preserve flags, boundaries, matching order, capture
  numbering, and offsets. Use constant-based `String.raw` patterns or the existing
  keyword helper as appropriate.
- Preserve UTF-16 source offsets, generic/comparison distinctions, comments/string
  masking, overload identities, and routine declaration/implementation relationships.
- Keep incidental prose and punctuation inline unless sharing them improves the code.
  Declarative grammar/snippet resources remain in their existing formats.

## Runtime, assets, and compatibility

- Edit source files, not generated output. The entrypoint is `out/src/extension.js`;
  workers also live in `out/src`, and browser bundles live in `out/webview`.
- Use `src/runtimePaths.ts` and extension context URI/path helpers for runtime assets
  and worker entrypoints. Static resources remain at the extension root.
- Keep webview scripts in the browser entrypoints. Preserve nonce-based CSP, safe
  serialized bootstrap data, webview resource URIs, and `localResourceRoots` when
  changing HTML or asset loading.
- Preserve public command IDs, configuration keys, message payloads, persisted-state
  keys, and cache formats unless the requested change includes a migration. Update
  cache/profile versions deliberately when their schemas or initialization behavior
  change.
- Keep expensive indexing and large-file parsing off the extension host. Preserve
  cancellation, document-version checks, stale-result handling, and worker disposal.
- Preserve existing encodings and project files. Compiler diagnostics use isolated
  shadow sources; formatting and other licensed tools must remain local. AI requests
  remain explicitly invoked and use the configured provider.

## Development and validation

Install the pinned dependencies with `npm ci`. Use the npm scripts in `package.json` as
the source of truth:

| Command                    | Purpose                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `npm run check-types`      | Strict checking of host/test and browser code                    |
| `npm run build`            | Compile host/tests and build browser bundles                     |
| `npm test`                 | Build and run Node regression tests                              |
| `npm run test:integration` | Build and exercise emitted worker entrypoints/protocols          |
| `npm run test:host`        | Run real VS Code providers/views in an isolated development host |
| `npm run package`          | Build through `vscode:prepublish` and create a local VSIX        |

- Use the configured `pre-commit` hooks for automatic formatting, following
  `.pre-commit-config.yaml` and `.prettierrc.json`. Run
  `pre-commit run --files <changed-files>` before finishing, review any automatic edits,
  and rerun until the hooks pass. Use `pre-commit install` when setting up local commit
  hooks. Keep runs scoped to changed files; use `--all-files` only for a requested
  repository-wide formatting pass.
- For a focused test, build first, then run `node --test out/test/<name>.test.js`. Use
  `test/helpers.ts` for repository source, emitted artifact, static resource, and
  browser bundle paths.
- Add or update tests for changed behavior and concrete regression risks. Test
  observable results rather than TypeScript annotation syntax; browser harnesses should
  execute the shipped bundles.
- Run type checking and relevant tests for code changes. Include worker integration
  checks for worker/protocol/path changes, host smoke checks for VS Code
  registration/provider/webview changes, and packaging checks for
  manifest/build/resource changes.
- For documentation-only changes, verify accuracy and run `git diff --check`; a full
  build is unnecessary.
- Host smoke tests use temporary workspace, profile, and extension folders under
  `.vscode-test`. Set `VSCODE_EXECUTABLE` to an installed executable or `VSCODE_VERSION`
  to an official release. Keep dependency auto-installation disabled in test profiles
  and do not use a user's normal profile as a test fixture.
- Report which checks ran and any toolchain-dependent coverage limits. The host fixtures
  intentionally disable Delphi compiler execution; do not present syntax-worker checks
  as compiler validation.
- For development watches, run `npm run watch`, `npm run watch:webviews`, and
  `npm run watch:webview-types` in separate terminals.

## Change discipline

- Keep changes within the requested feature or refactoring scope and preserve unrelated
  user work. Check the worktree before editing.
- Coordinate file ownership when parallel work is authorized, especially for shared
  models, protocols, and registries.
- Keep generated output, dependencies, VSIX files, smoke profiles, and temporary
  migration tooling out of source control. Update `.vscodeignore` when adding
  development-only files that must not ship.
- Packaging is local validation. Run Marketplace publishing commands only when
  publishing is requested by the user.
- Summarize the behavior changed, validation completed, and material limitations when
  handing work back.
