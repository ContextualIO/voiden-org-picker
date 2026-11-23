# Contextual Org Picker (Voiden plugin, prototype)

Voiden asks you to sign in when you don't have an OAuth token. This plugin adds the same kind of prompt for the **organization**. When you send a request that has an `x-org-id` header and you haven't chosen an org for the active environment yet, it:

1. fetches `GET {{AUTH_API_URL}}/organizations` with your OAuth token,
2. picks the org automatically if you only have one, or shows a searchable picker if you have several,
3. remembers your choice **for each environment** (Dev, QA and Prod are separate),
4. sets `x-org-id` to the chosen org on that request and on every later request that has an `x-org-id` header.

Requests without an `x-org-id` header are left untouched.

## Install

The source is TypeScript ([src/contextual-org-picker.ts](src/contextual-org-picker.ts)). `tsc` compiles it to a single ES module with no imports, which is what Voiden loads.

```sh
pnpm install
pnpm run check        # type-check only
pnpm run zip          # → dist/contextual-org-picker.zip
```

In Voiden, go to **Extensions → ⋯ → Install from file** and choose `dist/contextual-org-picker.zip`. Reload Voiden if it asks you to.

To update: download the zip from the latest GitHub release (or build it as above) and install it again.

## Releasing

Versions are managed with [Changesets](https://changesets.dev). Don't edit `version` in `package.json` or `manifest.json` by hand.

1. **In your PR:** run `pnpm changeset`, pick patch / minor / major, and write a one-line summary for the changelog. Commit the generated `.changeset/*.md` file with your change.
2. **On merge to `main`:** the [Release workflow](.github/workflows/release.yml) opens (or updates) a **chore: version packages** PR. It bumps `package.json` and `manifest.json` and adds the entries to `CHANGELOG.md`.
3. **Merge the version PR:** the workflow builds the plugin and creates GitHub release `vX.Y.Z` with these assets:
   - `contextual-org-picker.zip`, for **Install from file**
   - `manifest.json` and `contextual-org-picker.js`, the loose files the Voiden plugin registry downloads

To version locally instead (for example to preview the changelog), run `pnpm run version-packages`.

The workflow needs **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** turned on.

## Use

- **First request:** sign in through the OAuth prompt as usual. The org picker appears on your first request after that. If you have no token yet, that request goes out without an org and you get a warning toast; the picker appears on your next one.
- **Switch org:** click the org ID (or **Select org**) in the status bar, or run **Contextual: Switch organization** from the command palette.
- **Other commands:** **Contextual: Show current organization**, **Contextual: Clear organization**.
- **Cancelling the picker** cancels the request. Voiden reports this as "Request cancelled by pre-request script".

## How it works and caveats

The plugin uses Voiden internals that aren't in the public plugin docs, so a Voiden update could break it:

| Internal | Used for |
| --- | --- |
| `context.pipeline.registerHook('pre-send', …)` | Runs before every send; Voiden awaits the hook, so the picker can wait for your choice |
| `requestState.metadata.scriptCancelled` | Cancels the request when you dismiss the picker |
| `window.electron.env.load()` | Gets the active environment and resolves `AUTH_API_URL` |
| `window.electron.variables.readMerged()` | Reads `oauth2_access_token`, which the OAuth2 auth block stores |
| `window.electron.sendRequest()` | Fetches the org list from Electron's main process, which avoids CORS |
| Voiden's Tailwind theme classes (`bg-editor`, `border-border`, `text-text`, `text-comment`, `bg-active`, `border-accent` …) | The picker copies the markup of Voiden's built-in branch picker (`GitBranchesList.tsx`), so it matches the current theme. All classes were checked against the compiled CSS in Voiden 2.4.1 |

Checked against the Voiden source at commit `57a1c60` (2026-11-16).

Other limitations:

- The status bar shows the selected org ID for the active environment, or **Select org** if none is chosen. Hover it to see the org name. Voiden has no API to update a status bar item, so the label is a small React component that re-renders itself. This relies on Voiden rendering `label` as a React child and on its shared React (`window.__voiden_shims__.react`). If either changes, the label falls back to a fixed text.
- The selection is stored in the plugin's settings, keyed by environment. It isn't stored in the project, so every person picks their own.
- The plugin sets the value of **every** `x-org-id` header, which overrides any hard-coded value in a `.void` file.
