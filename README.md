# Spatial Reconstruction Trainer

A mental-rotation / spatial-reconstruction training app. Explore a procedurally
generated voxel object, watch it disappear, apply a rotation sequence (or not,
in beginner mode) mentally, then rebuild it on a fixed-reference-frame grid
and get exact voxel-level scoring.

## Local development

```bash
npm install
npm run dev
```

Opens a dev server (default http://localhost:5173) with hot reload.

## Production build

```bash
npm run build
```

Outputs static files to `dist/`. Preview the production build locally with:

```bash
npm run preview
```

## Deploying to Netlify

This repo includes a `netlify.toml` with the build already configured:

- Build command: `npm run build`
- Publish directory: `dist`

**Option A -- Netlify UI / drag-and-drop:**
1. Run `npm run build` locally.
2. Drag the resulting `dist/` folder onto https://app.netlify.com/drop.

**Option B -- Git-based deploy (recommended):**
1. Push this project to a GitHub/GitLab/Bitbucket repo.
2. In Netlify, "Add new site" -> "Import an existing project" -> pick the repo.
3. Netlify will detect `netlify.toml` and use the build command/publish dir automatically.
4. Deploy.

**Option C -- Netlify CLI:**
```bash
npm install -g netlify-cli
npm run build
netlify deploy --prod --dir=dist
```

## Project structure

```
index.html          Vite entry HTML (UI markup)
src/main.js         App logic (voxel generation, rotation math, scoring, UI)
src/style.css       Styles
package.json        Dependencies (three, vite) and scripts
netlify.toml        Netlify build configuration
```

Three.js is a normal npm dependency (`three`), imported via `import * as THREE
from 'three'` and bundled by Vite -- there is no CDN dependency and nothing
that assumes Claude's artifact runtime. The app uses no browser storage and no
Claude-specific APIs, so it runs identically anywhere a static site can be
hosted.

## Controls

- **Explore phase:** left-drag to orbit the camera, scroll to zoom.
- **Reconstruction phase:** left-click an empty cell to add a voxel,
  shift+left-click a voxel to remove it, right-drag to orbit the camera.
- Settings (gear icon) let you pick a difficulty preset or tune rotations
  on/off, cube count, rotation steps, and exploration time independently.
