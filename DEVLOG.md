# SkyShift development diary

How SkyShift was built during NASA Space Apps Challenge 2026 (14–15 November), including what went wrong and how we fixed it.

## Day 1: 14 November

### 1. Understanding the data
- Studied the challenge resources: SPHEREx Level 2 images at IRSA, the public AWS S3 bucket `nasa-irsa-spherex`, and the IRSA TAP service.
- Found that the list of exposures covering a position can be read from IRSA TAP (`spherex.plane` joined with `spherex.artifact`, `CONTAINS(POINT, poly)`).
- Found that the S3 bucket allows CORS and HTTP Range requests. That meant the browser could read only the rows of pixels it needs (about 0.4 MB) instead of a 66 MB FITS file.
- Problem: IRSA TAP does not send CORS headers, so a browser cannot query it directly. Decision: a tiny proxy (Cloudflare Worker or local Node server) that allows only read-only SELECT queries on SPHEREx and Gaia tables, with caching.

### 2. Reading FITS in the browser
- Wrote a FITS header parser and an extension map (IMAGE, FLAGS, VARIANCE, ZODI, PSF, WCS-WAVE).
- Implemented the TAN-SIP world-coordinate system in JavaScript and checked it against astropy (agreement better than 1e-9 pixels).
- Problem: the WCS-WAVE lookup table is 11×11 in some files and 9×9 in others, which first gave wrong wavelengths. Fix: read the table size from the TFORM keywords.
- The FLAGS extension is RICE_1 tile-compressed, so we wrote a small Rice decoder to show contamination flags.

### 3. Stacking and the blink movie
- Resampled every exposure onto a common north-up grid, grouped exposures into six-month epochs, and stacked each epoch (inverse-variance weighting).
- Problem: the first stacks showed fake stars and fake "moving objects". At first it looked like misalignment, but the cause was hot pixels and cosmic rays (about 0.7% of pixels in every exposure). Fix: robust stacking that rejects outliers against the median.
- Added the display modes: Blink, Difference, Colour = time, Infrared colour (6 detectors to RGB), and single Exposures with flags.

### 4. Spectra on the fly
- SPHEREx uses linear variable filters, so every exposure sees a different wavelength at the target's position. Measuring the target in all exposures and sorting by wavelength gives a 0.75–5 µm spectrum.
- Problem: single hot pixels produced spikes in the spectrum. Fix: a rolling outlier filter along wavelength, then log-spaced bins per detector.

### 5. Motion measurement
- Centroids per epoch, corrected with field stars (registration), then a straight-line fit gives the proper motion.
- Problem: WISE 0855 came out with the wrong motion. It sits 6–9″ from a background star, which pulled the centroid. Fix: a joint PSF fit of the target and its neighbours, plus automatic choice of the detectors where a shift-and-add stack along the expected track beats a normal stack (for WISE 0855: D5+D6, where it is brightest).
- Problem: R Draconis is so bright it saturates the detector (masked core). Fix: photometry in a ring on the PSF wings.
- Added Mover Scan: every source in the field is tracked and significant movers are flagged. Saturated stars are skipped because they produced a false mover.

### 6. Validation on the challenge targets

| Target | Measured by SkyShift | Catalogue |
|---|---|---|
| Barnard's Star | −0.76 ± 0.52, +10.22 ± 0.31 ″/yr | −0.80, +10.36 |
| WISE 0855−0714 | −7.85 ± 1.06, −0.21 ± 0.58 ″/yr | −8.12, +0.67 |
| ε Indi B | +3.54 ± 0.19, −2.70 ± 0.21 ″/yr | +3.97, −2.54 |
| RW Aurigae | no motion (0.8 ± 0.8 ″/yr), ~9% brightness change | — |
| R Draconis | ~59% brightness change between epochs | Mira variable, 245 d |

### 7. Deployment
- Local server (`proxy/server.js`), Cloudflare Worker proxy, browser cache (IndexedDB), URL parameters and embed mode.
- IRSA TAP took 8–90 s per query during the hackathon, so exposure lists are cached and the featured targets are pre-fetched.

## Day 2: 15 November
- Testing the search bar. Found that planet names cannot be resolved: the name resolver (CDS Sesame) only knows objects with fixed coordinates. The app now explains this instead of failing silently.
- Publishing: GitHub repository and GitHub Pages workflow that refreshes the exposure lists every week, so new SPHEREx releases appear automatically.

## Tools
Plain JavaScript (no framework), Node.js for the proxy and scripts, astropy for checking the WCS. The code was written with the help of an AI assistant (Claude, by Anthropic) as a pair programmer. Testing, debugging decisions and validation were done by the team.
