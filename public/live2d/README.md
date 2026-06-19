# Live2D assets (drop-in)

This folder is served verbatim at the web root (`/live2d/...`) by Vite/Electron
Forge. **Nothing here is bundled** — the files are fetched at runtime by the
renderer. Nero boots and shows the built-in pixel cat when these assets are
missing, so you can develop Voice + the event pipeline before a model exists.

To swap Nero to a Live2D avatar, drop in two things:

## 1. Cubism Core runtime (required for ANY Live2D model)

Cubism Core is **not on npm** and **cannot be bundled** (it attaches a global
`window.Live2DCubismCore`). It is loaded by a classic `<script>` tag in
`index.html` BEFORE the renderer bundle:

```html
<script src="/live2d/live2dcubismcore.min.js"></script>
```

Download it once into this folder:

```bash
curl -L -o public/live2d/live2dcubismcore.min.js \
  https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js
```

(If you also want Cubism 2.1 models, additionally self-host `live2d.min.js`.)

## 2. A Cubism 4 model

Drop the WHOLE model folder here. The default path the renderer looks for is:

```
public/live2d/Haru.model3.json   (with its textures/, motions/, *.exp3.json, *.physics3.json alongside)
```

Override the path via `window.COMPANION_CFG.modelUrl` or the
`VITE_LIVE2D_MODEL_URL` build env. Example using the Live2D sample "Haru":

```bash
# from a checkout of Live2D/CubismWebSamples:
cp -R CubismWebSamples/Samples/Resources/Haru/* public/live2d/
```

**Ship the ENTIRE folder.** A missing texture renders a silently broken /
transparent model with no thrown error. Confirm `Haru.model3.json` lists
`FileReferences.Moc`, `Textures[]`, `Motions{Idle,TapBody}`, `Expressions[]`.

## How the renderer chooses model vs placeholder

`src/renderer/character/avatar.ts`:

1. Checks `typeof window.Live2DCubismCore === 'object'` (core loaded?).
2. `fetch(modelUrl, { method: 'HEAD' })` — does the model file exist?
3. If both pass, `Live2DModel.from(modelUrl)`. On any failure it logs a warning
   and renders the placeholder.

The `CharacterDriver` facade (`setState` / `setMouthOpen` / `setTalking` /
`speak`) is **identical** for the model and the placeholder, so Voice and the
ActionEvent pipeline are model-agnostic.

## State map (tune to your model)

`src/renderer/character/stateMachine.ts` maps the 6 avatar states to
`expression`/`motion`. The defaults assume Haru (groups `Idle`/`TapBody`,
expressions `f01..f08`). Discover your model's real names at runtime:

```js
Object.keys(model.internalModel.motionManager.definitions)               // motion groups
Object.keys(model.internalModel.motionManager.expressionManager?.definitions ?? {}) // expressions
```

The mouth lip-sync param is assumed to be `ParamMouthOpenY` (Cubism 4). Change it
in `lipsync.ts` if your model differs.

## License note

Live2D sample models (Haru, etc.) are covered by the Live2D Free Material /
Sample Data terms — fine for a hackathon demo, NOT for unrestricted commercial
use. Keep the model's license file alongside the assets.
