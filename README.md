# SkyShift — watch the infrared sky move with NASA SPHEREx

**NASA Space Apps Challenge 2026 · “Planet X and SPHEREx”**

 **Development diary:** [DEVLOG.md](DEVLOG.md)

SkyShift is a public web tool that turns NASA SPHEREx images into a time-lapse of any patch of sky.
Type a name or coordinates, and within seconds you see the sky blink between epochs six months apart.
SkyShift then measures, live in your browser, **how things move, how they change brightness, and what
their 0.75–5 µm infrared spectrum looks like**.

## What it does

| Feature | What the user sees | Challenge item it answers |
|---|---|---|
| **Blink** | Six-month epochs, each a stack of many exposures (much less noise), played as a movie | “display a series of images … like a little video” |
| **Difference** | Each epoch minus all others: movers become red/blue pairs | “add together or subtract images taken at different times” |
| **Colour = time** | One still image: still stars white, movers leave a rainbow trail | new |
| **Infrared colour** | The 6 detectors combined to RGB: cold brown dwarfs glow red | “think creatively about how to display those 102 bands” |
| **Exposures** | Every single exposure in time order (fast asteroids), with contamination flags | “display metadata, like contamination flags” |
| **Spectrum on the fly** | 102-channel 0.75–5 µm spectrum built from all exposures, with molecule markers and a plain-language verdict | “extra kudos if your tool can generate spectra on the fly” |
| **Brightness history** | Light curve corrected for SPHEREx's changing wavelength; saturated stars measured from their PSF wings | variable stars RW Aur, R Dra |
| **Motion measurement** | Sub-pixel astrometry with field-star registration and joint PSF fitting of blended neighbours; compares with catalogue proper motion | brown dwarfs, Barnard's Star |
| **Mover Scan** | Every source in the field is tracked; significant movers get arrows; Gaia match flags candidates with no Gaia counterpart | “help as many people as possible make discoveries” |
| **Gaia + sky map** | Gaia DR3 stars propagated to each epoch; Aladin Lite context map (AllWISE / 2MASS / DSS / Pan-STARRS) | “overlay data from Gaia or WISE”, “Aladin” |
| **Field of view** | 2′ to 30′, with a live data-volume estimate | “let users choose the field of view” |
| **URLs & embeds** | `?target=wise0855`, `?ra=133.76&dec=-7.24&fov=6&dets=56&mode=diff`, `&embed=1` | “query your tool by including coordinates in the URL” |
| **Works when IRSA is busy** | Exposure lists come from two independent IRSA services (TAP and SIA) at once; whichever answers first wins, so any position on the sky works even when TAP is overloaded | “help as many people as possible” |
| **Always up to date** | Every query asks the archive for *all* releases (DR1, QR3, future ones); newest processing wins | “easy to update with the latest data releases” |

## Validation on the challenge targets (measured by SkyShift, Nov 2026)

| Target | Result | Catalogue |
|---|---|---|
| Barnard's Star | μα\* = −0.76 ± 0.52, μδ = +10.22 ± 0.31 ″/yr; also found blind by Mover Scan (12.7″/yr, 7σ) | −0.80, +10.36 ″/yr |
| WISE 0855−0714 | μα\* = −7.85 ± 1.06, μδ = −0.21 ± 0.58 ″/yr — auto-selected D5+D6 and de-blended from a field star 6″ away; “invisible below 4 µm, bright at 4–5 µm” | −8.12, +0.67 ″/yr |
| ε Indi B (brown-dwarf pair) | μα\* = +3.54 ± 0.19, μδ = −2.70 ± 0.21 ″/yr; found blind by Mover Scan at 25σ (the pair is unresolved at 6″ pixels) | +3.97, −2.54 ″/yr |
| RW Aurigae | No significant motion (0.8 ± 0.8 ″/yr), ~9 % brightness change between epochs | young variable, distant |
| R Draconis | Saturated → wing photometry; brightness changes by ~59 % between epochs, peaks ~8 months apart | Mira, P = 245 d |

SPHEREx pixels are 6.2″, so Barnard's Star moves 1.7 pixels per year and WISE 0855 1.3 — SkyShift recovers these
with sub-pixel precision.

## How it works

```
 Browser (all the science runs here)
 ├─ 1. "Which exposures cover this spot?"  ──► SkyShift proxy (Cloudflare Worker, 24 h cache) ─┬► IRSA TAP (spherex.plane/artifact)
 │                                                                           └► IRSA SIA (all spherex_* releases) — asked in parallel, first answer wins
 ├─ 2. FITS header (≈26 kB)               ──► AWS S3 nasa-irsa-spherex (public, CORS, HTTP Range)
 ├─ 3. Only the pixel rows we need (≈0.4 MB instead of a 66 MB file or a 4 MB IRSA cutout)
 ├─ 4. TAN-SIP WCS (verified against astropy to 1e-9 px) → resample to a north-up grid
 ├─ 5. Robust (outlier-clipped) inverse-variance stacks per epoch & detector
 ├─ 6. Wavelength per pixel from the WCS-WAVE lookup table → spectra & light curves
 └─ 7. Astrometry: centroids / joint PSF fits + field-star registration → proper motion (+ experimental parallax)
```

Everything is cached in the browser (IndexedDB), so a second visit is instant. No build step, no framework, no server-side compute.

## Run it

**Local (one command, needs Node.js):**
```
node proxy/server.js        # → http://localhost:8080  (serves the app and the proxy)
```
Every archive answer is also saved to `proxy/.cache/`, so any target opened once keeps working after a restart,
even if IRSA is down. Before a demo, open each target you plan to show once.

**Public deployment (free, ~10 minutes):**
1. Cloudflare → Workers → create a worker → paste `proxy/worker.js` → Deploy. Copy its URL.
2. Put that URL in `web/config.js` (`proxy: 'https://…workers.dev'`).
3. Push to GitHub and set *Settings → Pages → Source* to **GitHub Actions**. The workflow in `.github/workflows/pages.yml`
   refreshes the exposure lists for the featured targets from IRSA (`tools/build-cache.js`) and publishes `web/`.
   It re-runs every week, so new SPHEREx data releases appear automatically.

`node tools/build.js` also produces `dist/index.html`, a single self-contained file.

## Honest limitations
* Photometry is aperture/PSF-wing based without aperture corrections: excellent for colours, spectral shapes and changes, approximate in absolute flux.
* Parallax needs more epochs than exist today; it is shown only when its error is small.
* The joint fit is seeded with the catalogue track when one is known; for unknown objects it starts from the brightest nearby peak.

## Use of AI tools
The code and documentation were developed with the assistance of an AI assistant (Claude, by Anthropic), used as a pair
programmer. The team chose the approach, tested the tool on the challenge targets, diagnosed the problems listed in
[DEVLOG.md](DEVLOG.md) and validated the results against published catalogues. No AI-generated images are used.

## Credits
SPHEREx data: NASA/JPL-Caltech, via NASA/IPAC Infrared Science Archive and AWS Open Data. Gaia DR3: ESA/Gaia/DPAC (via IRSA).
Name resolver and Aladin Lite: CDS, Strasbourg. *This research made use of data from the SPHEREx mission, funded by NASA and managed by JPL/Caltech.*
