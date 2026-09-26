# Vendored, not bundled

This page is served as the files you see — no build step between source and browser. These
two make that possible: `htm` is a tagged template, so there is no JSX to compile.

| | |
| --- | --- |
| `preact.module.js` | preact 10.29.8, `dist/preact.module.js` |
| `htm.module.js` | htm 3.1.1, `dist/htm.module.js` |

Both are devDependencies of this package only so the lockfile pins those versions. Refresh
with:

```bash
npm run vendor:ui
```

Source maps are stripped, since the maps themselves are not published.
