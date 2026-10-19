# Camera Overlay

Camera Overlay is a browser camera for consistent before/after photos. Load the before photo and it shows over the live view as a faint ghost or an outline, so you can line up the follow-up shot with the same framing, tilt and lighting. It runs entirely in the browser as an installable web app, and photos are read from and saved to your device's own photo library.

## Using it

1. Tap Start Camera and allow camera access.
2. Tap the picture button at the bottom left and choose the before photo.
3. Drag the ghost to move it and pinch to resize it. Watch the Tilt and Lighting badges, then tap the shutter.

## Focus mode

The Focus button next to the Ghost slider blacks out everything except the subject. Tap it, draw a loop around the subject with your finger, and lift. The loop snaps onto the subject's edge like the magnetic lasso in Photoshop, so it only needs to run close to the subject. The live camera shows inside it and everything else goes fully black, outline lines included. The loop belongs to the before photo, so it moves with the ghost when you drag, pinch or flip it. Tap Focus again to turn it off. The next tap starts a new loop and shows the last one dashed: draw a new one, or tap Focus to keep the last one. Dragging never moves the ghost while you're drawing. Focus mode only changes the on-screen view and never appears in a saved photo.

## Patient, visit and angle sets

Tap the chip under the top bar to set the patient and the visit, like "Maria S." and "Week 4". Both go into the saved file names, for example `cygnus-maria-s-week-4-front-grid-20261019-094101.jpg`. The visit and angle also go on the grid, but the patient name doesn't, since grids often get shared. None of it is kept after the app closes, and "Clear for the next patient" empties it along with the before photos.

Turn on Angle set to shoot Front, Left 45°, Left profile, Right 45° and Right profile in order. Each angle keeps its own before photo, ghost position and Focus loop, and the app moves to the next unsaved angle after each save. Picking several before photos at once fills the angles in order from the current one.

## Saving

Auto-align lines the before photo up with the new one before the review sheet opens. It finds the small shift, size change and turn that make the two match best, using only the subject when a Focus loop is drawn, then crops both to the area they share. It works on shots that are off by up to about 12% in position, 10% in size and 6° in angle, and it handles a darker or brighter after photo. Only the before photo is moved. The review sheet says what it changed, and the Auto-align switch there shows the photos as framed instead. The single photo is always saved untouched.


With a before photo loaded, the review sheet shows a before/after wipe you can drag, a grid preview, and a choice of Side by side or Stacked for the grid. Save as grid, Save as single photo or Save both. The grid shows the date of each photo, read from the before photo's EXIF data or file date. Without a before photo, the shot saves straight away.

## Camera buttons

The top bar has, from left to right:

- **Hide controls:** clears the badges, hint and extra buttons off the view.
- **Self-timer:** cycles through off, 2, 3 and 5 seconds. Tapping the shutter during the countdown cancels it.
- **Lock:** locks exposure and white balance at their current values, so the lighting doesn't drift between shots. It only shows on cameras that support it, mainly Chrome on Android.
- **Flashlight:** shows only where the camera supports it.

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
