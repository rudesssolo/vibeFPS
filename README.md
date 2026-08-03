# VIBE FPS

VIBE FPS is a browser-based cyberpunk first-person shooter tech demo. Enter a neon-lit urban arena, fight increasingly aggressive waves of sentinel drones, and survive with the help of a tactical HUD, real-time physics, and procedural audio.

## Features

- Real-time 3D rendering with Three.js and WebGPU
- A cyberpunk night arena with procedural buildings, neon lighting (with animated sign flicker), rain, fog, reflections, bloom, ambient occlusion, film grain, and cinematic color grading
- Shader warm-up during loading (`compileAsync` + one offscreen post-chain render) so the first frame, shot, and explosion never stutter
- Physics-based movement, jumping, a launch pad, collisions, and projectile simulation powered by Cannon.js
- Wave-based combat against drones that patrol, engage, telegraph attacks, and evade incoming projectiles
- Weapon feedback with muzzle shots, tracers, melee strikes, hit markers, explosions, shockwaves, reload and landing camera animation, damage effects, score, and combo tracking
- Enemy rewards: kills restore health and create collectible ammunition drops
- A true pause menu (simulation fully suspended, ducked audio) with a complete level reset action
- Pure procedural music, ambience, spatialized drone sounds, wave stingers, a critical-health heartbeat, and sound effects generated with the Web Audio API (no MP3/WAV assets)
- Responsive tactical HUD with mission progress, radar, health, shield, stamina, ammo, telemetry, and target markers
- Auto and Ultra graphics profiles, plus persistent music, effects, ambience, mouse sensitivity, and mute settings

## Requirements

- A modern desktop browser with WebGPU and Pointer Lock support
- No internet connection needed: Three.js and Cannon.js are vendored in `vendor/` (three.js 0.184.0, cannon.js 0.6.2)

The game is designed for keyboard and mouse. Headphones are recommended for the spatial audio experience.
The distributed build requires WebGPU. If the browser or device cannot provide a WebGPU adapter, the start menu shows an explicit warning and the simulation remains disabled.

## Run locally

Because the project uses JavaScript modules, serve it over HTTP instead of opening `index.html` directly:

```bash
git clone https://github.com/rudesssolo/vibeFPS.git
cd vibeFPS
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080) in a supported browser and click **INITIALIZE SIMULATION**. Any other static file server can be used in place of Python's built-in server.

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` or arrow keys | Move |
| `Shift` | Sprint |
| `Space` | Jump |
| Left mouse button | Fire |
| Right mouse button | Melee strike |
| `R` | Reload |
| `M` | Toggle audio |
| `Esc` | Release pointer lock and pause |

The arena also contains a jump pad that launches the player automatically on landing. Defeat every drone in a wave to advance; later waves contain tougher and more numerous enemies. During a pause, use **RESET LIVELLO** in the settings panel to restart the run from wave 1.

## Project structure

```text
index.html              Game entry point, scene setup, gameplay loop, and input handling
styles/hud.css          HUD and responsive visual overrides
src/config.js           Quality, movement, drone, and audio persistence settings
src/graphics-manager.js Adaptive graphics quality management
src/rng.js              Deterministic seeded PRNG for procedural generation
src/render-pipeline.js  GTAO, bloom, SMAA, grain, grading, shockwave and vignette post chain
src/drone-system.js     Drone spawning, movement, attacks, and evasive behavior
src/explosion-system.js Explosion pooling, particles, and shockwave effects
src/facade-system.js    Procedural building facade generation
src/textures.js         Procedural canvas/texture generators (asphalt, metal, wood, PBR, signs)
src/audio-engine.js     Singleton procedural AudioEngine, SFX, drone, arpeggiator, and spatial audio
src/hud-controller.js    HUD onboarding and simulation settings
vendor/                 Vendored runtime dependencies (three.js WebGPU build + addons, cannon.js)
tools/smoke-boot.mjs    Headless boot smoke test (module graph, vendoring, WebGPU fallback path)
```

## Settings

The start screen provides two graphics modes:

- **Auto** adapts between balanced and high quality according to frame rate.
- **Ultra** uses the highest configured render quality.

Music, sound effects, ambience, mouse sensitivity, and the selected graphics mode are stored in `localStorage` for the current browser profile. The HUD telemetry also shows a live **accuracy** readout (hits / shots).

## Development notes

There is no build step or package installation required. Most game logic currently lives in `index.html`, while reusable systems are organized under `src/`. External library versions are pinned by vendoring them under `vendor/` (the import map points at local files; no CDN is involved at runtime).

Automated checks:

```bash
npm test        # unit tests (node --test, no browser needed)
npm run smoke   # headless boot smoke test — requires playwright + chromium
                # (`npx playwright install chromium`); verifies zero JS errors,
                # zero missing resources, and the no-WebGPU recovery panel
```

The manual pre-presentation GPU checklist lives in `bugs-remediation-plan.md` (§15).
