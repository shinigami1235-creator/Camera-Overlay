# Camera Overlay

Camera Overlay is a browser camera for consistent before/after photos. Load the before photo and it shows over the live view as a faint ghost or an outline, so you can line up the follow-up shot with the same framing, tilt and lighting. It runs entirely in the browser as an installable web app, and photos are read from and saved to your device's own photo library.

## Using it

1. Tap Start Camera and allow camera access.
2. Tap the picture button at the bottom left and choose the before photo.
3. Drag the ghost to move it and pinch to resize it. Watch the Tilt and Lighting badges, then tap the shutter.

## Focus mode

The Focus button next to the Ghost slider blacks out everything except the subject. Tap it, draw a loop around the subject with your finger, and lift. The live camera shows inside the loop and the rest goes black. The loop belongs to the before photo, so it moves with the ghost when you drag, pinch or flip it. Tap Focus again to turn it off and on, and use the pencil button beside it to redraw the loop. Focus mode only changes the on-screen view and never appears in a saved photo.

## Settings

Readout style, active camera, photo shape, ghost style, outline color and intensity, and zoom matching are in the settings sheet at the top right.

## Running it

There is nothing to build. Serve the folder over HTTPS (GitHub Pages works) and open `index.html`, since browsers only allow camera access on secure pages. For local testing, `python -m http.server` and then `http://localhost:8000` also works.

## Files

- `index.html`, `styles.css`, `app.js`: the app
- `sw.js`, `manifest.json`: offline use and installing it to the home screen
- `vendor/piexif.js`: reads and writes the tilt reference stored in each photo's EXIF data
- `scripts/make_icons.py`: regenerates the icons in `icons/`

Cygnus Solutions
