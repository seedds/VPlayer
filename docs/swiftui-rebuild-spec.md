# VPlayer SwiftUI Rebuild Spec

## Purpose

This document describes the current VPlayer app in product terms and translates it into a SwiftUI-oriented implementation blueprint.

Primary goal:

- rebuild the current app in SwiftUI with feature parity

Secondary goal:

- keep the current browser-based local upload workflow as the primary import path
- also document iOS-native import alternatives as optional future enhancements

## Product Summary

VPlayer is a local-first media player focused on Android tablets and phones. It stores video files and matching subtitle files inside the app sandbox, exposes a lightweight HTTP upload server so files can be sent from a browser on the same network, and provides a full-screen player with custom controls, gesture-based playback actions, subtitle support, playback persistence, and queue-style next-item playback.

Core product pillars:

- local browser upload over the same LAN
- private in-app media library
- fast local playback with resume support
- subtitle pairing by filename
- simple, gesture-friendly player controls

## Current Platform Behavior

Current implementation assumptions:

- Android-first
- Expo / React Native app with native modules for local HTTP serving
- no cloud account, no remote sync, no authentication
- local sandbox storage only

Orientation behavior today:

- phones use portrait outside the player
- Android tablets use landscape outside the player
- the player always enters landscape while active

For the SwiftUI rebuild, recommended parity behavior:

- iPhone: portrait outside player, landscape in player
- iPad: allow landscape-first behavior, but keep this configurable

## Scope

### In Scope

- local upload server and browser upload page
- media library list
- video playback
- `.srt` subtitle loading and display
- playback progress persistence
- generated thumbnail cache
- custom player controls and gestures
- lock mode in player
- queue-style next video behavior
- delete single and multiple items

### Out of Scope for Parity

- cloud sync
- user accounts
- transcoding
- online subtitles search
- metadata scraping
- playlists beyond simple next-in-list order
- search / sort / filtering UI
- background server daemon outside active app lifecycle

## Supported Media

Accepted file types:

- video: `.mp4`, `.mov`, `.m4v`, `.webm`, `.mkv`
- subtitles: `.srt`

Matching rule for subtitles:

- subtitle file matches a video when both share the same basename, case-insensitive
- example: `Movie.mp4` matches `Movie.srt`

## App Structure

The app has two main tabs and one modal/full-screen playback experience.

### Screens

1. Library
2. Upload
3. Player

### Launch Flow

On app launch:

1. ensure required app directories exist
2. load local library items
3. load saved playback state
4. inspect storage snapshot
5. detect current LAN IP if possible
6. start or adopt the local upload server on port `8080`

## Screen Specifications

## 1. Library Screen

### Purpose

Show all locally stored videos and subtitle files, allow playback entry, selection, deletion, and playback-state clearing.

### Layout

- top toolbar
- vertical list of media rows
- empty state when no media exists

### Toolbar States

Normal mode:

- shows `Clear playback` action

Selection mode:

- shows selected count
- shows `Cancel`
- shows `Delete`

### Empty State

Show friendly instructional copy directing the user to the Upload tab and browser upload flow.

### Row Content

Each row may represent either a video or a subtitle file.

Video row displays:

- generated thumbnail, or fallback placeholder
- filename
- saved position / total duration
- status badge area
- delete button when not in selection mode

Subtitle row displays:

- subtitle placeholder
- filename
- `Subtitle file` secondary label
- delete button when not in selection mode

### Video Row State Indicators

- `[new]` if playback has not started
- circular progress badge if partially watched
- checkmark badge if watched to at least 95%

### Row Interactions

Normal mode:

- tap video row -> open player for that video
- tap subtitle row -> find video with same basename and open it if found
- long press anywhere on row -> enter selection mode and select the row
- tap delete button -> delete that item only

Selection mode:

- tap row -> toggle selected state
- long press row -> also toggle selected state
- delete buttons are replaced by selection indicator UI

### Selection Mode Behavior

- maintains a set of selected video URIs
- supports bulk delete
- automatically exits if selected count drops to zero

### Clear Playback Behavior

`Clear playback` should:

- preserve library files
- clear saved position to `0`
- mark all videos as not started
- keep known duration if available
- update UI immediately so videos become `[new]`

## 2. Upload Screen

### Purpose

Expose the local upload server and let another device send files through a browser on the same network.

### Layout

- server status area
- current local URL display
- port input
- Start/Restart button
- Stop button
- upload activity / progress area

### Behavior

- server starts automatically at launch
- if a compatible server is already running on the target port, the app adopts it instead of starting a duplicate
- upload tab is intended to remain open during transfers
- while actively receiving uploads, app should keep device awake

### Server Status Details

Show:

- running vs stopped state
- full LAN URL when IP is known
- fallback message if server is running but IP is not yet known
- current activity message

### Port Rules

- default port is `8080`
- valid range is `1025...65535`
- restart should apply new port setting

### Upload Activity Model

Display status, such as:

- idle
- receiving
- complete
- error
- stopped

Optional details:

- file name
- received bytes
- total bytes
- last updated time

## 3. Player Screen

### Purpose

Provide immersive local video playback with subtitles, progress persistence, gestures, scrub preview, and lockable controls.

### Entry Behavior

When player opens:

- lock orientation to landscape
- load saved playback position for the video
- seek to saved position
- auto-load matching subtitle file if available
- autoplay if app is active and playback has not been interrupted by sleep/background logic

### Exit Behavior

When player closes:

- persist current playback position
- release player resources
- restore app-level orientation lock
- refresh library metadata in parent flow

### Visual Regions

- full-screen video
- subtitle overlay near bottom
- top overlay with `Back`, filename, `Next`
- center controls with lock button and transport controls
- bottom overlay with scrub bar and time labels

### Top Controls

- `Back` closes player and saves progress
- center shows video filename
- `Next` appears only when another video exists in current list order

### Center Controls

- lock / unlock button
- seek backward `-10`
- play / pause
- seek forward `+10`

### Bottom Controls

- full-width progress bar
- elapsed time
- remaining time
- scrub preview popup above bar while dragging

## Player Gesture Spec

### Single Tap

On background only:

- if controls are visible -> hide controls
- if controls are hidden -> show controls

This should work in both locked and unlocked states.

### One-Finger Double Tap

On background only:

- toggle play / pause
- do not force controls visible

### Two-Finger Double Tap

On background only:

- toggle between locked and unlocked control state

### Lock Mode

When locked:

- hide top overlay
- hide transport controls
- hide seek bar
- when controls are visible, show only the lock/unlock button
- auto-hide should still apply so the lock button can hide itself after inactivity during playback
- single tap should still show or hide the lock button
- one-finger double tap should still play/pause
- two-finger double tap should still unlock

### Scrubbing

When dragging the progress bar:

- update target scrub time continuously
- show a small preview popup above the seek bar
- generate preview thumbnails continuously, latest-position-first
- do not pause playback solely for preview generation
- commit actual seek when drag ends

### Sleep / Wake / Focus Loss

When app loses focus, blurs, backgrounds, or device sleeps:

- pause playback
- save playback position
- clear scrub preview
- exit scrubbing state
- reset lock mode to unlocked
- show controls

When app returns to active state:

- remain paused
- do not auto-resume

### End of Video

When a video ends:

- persist current position
- hide controls
- if another video exists in current list order, auto-advance to the next item

## Subtitle Specification

### Loading

- find matching `.srt` by basename
- parse subtitle cues from file contents

### Display

- centered near bottom
- large white text
- outlined for readability

### Timing Behavior

- driven by actual playback time
- should remain synced to playing position even while scrub preview is shown
- after seek completion, subtitle timing should reflect the new playback position

## Data Model

## Library Types

### VideoItem

- `id`
- `kind = video`
- `name`
- `uri`
- `size`
- `modified`
- `extension`

### SubtitleItem

- `id`
- `kind = subtitle`
- `name`
- `uri`
- `size`
- `modified`
- `extension`

### LibraryItem

- union of `VideoItem` and `SubtitleItem`

### UploadActivity

- `status`
- `message`
- `updatedAt`
- optional `fileName`
- optional `receivedBytes`
- optional `totalBytes`

### StorageSnapshot

- `freeBytes`
- `totalBytes`

### PlaybackStateEntry

- `positionSeconds`
- optional `durationSeconds`
- optional `hasStartedPlayback`
- `updatedAt`

## Storage Layout

Current storage model uses app-private filesystem paths.

Recommended SwiftUI parity layout under app sandbox documents directory:

- `videos/` for final media and subtitle files
- `uploads-tmp/` for active upload assembly files
- `thumbnails/` for cached preview images
- `playback-state.json` for progress persistence

### File Rules

- sanitize incoming filenames
- preserve extension
- allow only supported extensions
- resolve collisions by appending `-1`, `-2`, etc.

### Sorting

- sort library alphabetically by filename
- locale-aware, numeric-aware, case-insensitive where possible

## Upload Server Specification

## Server Basics

- bind to `0.0.0.0`
- plain HTTP only
- default port `8080`

## Endpoints

### `GET /`

Returns an HTML upload page.

### `GET /health`

Returns JSON health info including:

- `ok`
- active port
- active upload count
- supported extensions

### `POST /upload/init`

Starts an upload session.

Expected request body:

- file name
- total size

Response should provide enough session info to continue chunk upload.

### `POST /upload/chunk`

Uploads binary chunk data.

Behavior:

- current implementation uses 1 MB chunk size
- validates upload ID and chunk metadata
- appends or writes chunk into temp upload target
- updates in-app progress state

### `POST /upload/complete`

Finalizes upload.

Behavior:

- validate total bytes received
- move temp file to final media directory
- refresh library
- emit completion activity

### `POST /upload/cancel`

Cancels upload and removes temp file.

## Browser Upload Page

Expected browser page behavior:

- file picker
- drag and drop
- multiple file selection
- sequential upload within a batch
- per-file progress UI
- overall progress and speed indicator

### Validation Rules

- reject unsupported extensions
- reject invalid metadata
- reject missing upload sessions
- reject incomplete uploads on completion

## Thumbnail Specification

### Library Thumbnails

- generated and cached for videos
- current implementation targets roughly 60 seconds into playback, or near end for short videos
- used in library rows

### Scrub Preview Thumbnails

- generated during active scrubbing
- shown in popup above slider
- only latest meaningful scrub position matters
- stale thumbnail requests should be discarded

## SwiftUI Rebuild Blueprint

## Recommended Architecture

Suggested layers:

- `App`
- `Screens`
- `Components`
- `ViewModels`
- `Services`
- `Models`
- `Utilities`

### Suggested Module Breakdown

- `Models`
  - `VideoItem`
  - `SubtitleItem`
  - `PlaybackStateEntry`
  - `UploadActivity`
  - `StorageSnapshot`
- `Services`
  - `LibraryService`
  - `PlaybackStateService`
  - `ThumbnailService`
  - `SubtitleService`
  - `UploadServerService`
  - `NetworkInfoService`
- `ViewModels`
  - `AppViewModel`
  - `LibraryViewModel`
  - `UploadViewModel`
  - `PlayerViewModel`
- `Screens`
  - `LibraryScreen`
  - `UploadScreen`
  - `PlayerScreen`
- `Components`
  - `MediaRowView`
  - `UploadStatusView`
  - `PlayerControlsOverlay`
  - `ScrubPreviewView`
  - `SubtitleOverlayView`

## SwiftUI Screen Mapping

### App Root

Use a `TabView` with:

- `Library`
- `Upload`

The player can be shown with:

- `fullScreenCover`, or
- navigation destination that forces immersive playback mode

Recommended:

- `fullScreenCover` for closer parity with the current app

### Library Screen

Use:

- `ScrollView` + lazy stack, or
- `List` if you do not need highly custom row behavior

Recommended:

- `ScrollView` + `LazyVStack` for more predictable custom gesture behavior

### Upload Screen

Use:

- status cards
- port text field
- start/stop buttons
- progress and recent activity summary

### Player Screen

Use:

- `AVPlayer`
- `AVPlayerLayer` via `VideoPlayer` or custom UIKit bridge
- overlay stack for subtitles and controls

Recommended:

- custom `AVPlayerLayer` wrapper instead of SwiftUI `VideoPlayer`, because gesture and overlay control is easier

## Service Design

### LibraryService

Responsibilities:

- ensure folders exist
- list media items
- validate file extensions
- sanitize file names
- allocate final and temp upload targets
- delete media items
- find matching subtitle for a video
- report storage snapshot

### PlaybackStateService

Responsibilities:

- load/save JSON playback state
- get saved position for URI
- save duration and started-state
- clear one item or all items

### ThumbnailService

Responsibilities:

- generate and cache library thumbnails
- generate transient scrub preview thumbnails
- invalidate stale requests
- delete thumbnail cache entry when video is deleted

Possible iOS tools:

- `AVAssetImageGenerator`

### SubtitleService

Responsibilities:

- load `.srt`
- parse cue ranges and text
- resolve active subtitle for current time

### UploadServerService

Responsibilities:

- host local HTTP server
- serve upload page
- manage chunked upload sessions
- emit progress/activity to UI
- finalize uploads and notify library refresh

Possible iOS implementation options:

- `GCDWebServer`
- `Telegraph`
- custom lightweight `Network.framework` HTTP server

Recommended:

- `GCDWebServer` for simplicity and reliability

## Player Implementation Notes for SwiftUI

### Playback Engine

Use `AVPlayer` plus observers for:

- current time
- playing state
- end of item
- app lifecycle notifications

### Subtitle Timing

- keep parsed cues in memory
- compute active subtitle for current playback time on periodic observer updates

### Scrub Preview

- while dragging, map gesture location to target time
- request thumbnail for latest time only
- show popup above slider
- on release, perform actual seek

### Gesture Handling

SwiftUI gestures alone may be awkward for exact multi-touch tap differentiation.

Recommended:

- use a small UIKit bridge with `UITapGestureRecognizer`
- configure separate recognizers for:
  - single tap, one touch
  - double tap, one touch
  - double tap, two touches

This is the closest equivalent to the current behavior.

### Orientation Handling

SwiftUI orientation control usually needs UIKit integration.

Recommended:

- control supported orientations from hosting controller / app delegate bridge
- lock landscape while player is active
- restore portrait on iPhone after dismissal

## Parity Upload Flow vs iOS-Native Enhancements

## Primary Parity Requirement

Keep the local browser upload server as a first-class feature.

Why:

- it is central to the current app
- it enables laptop-to-device transfer without cables
- it preserves current user workflow

## Optional Native Enhancements

These are not required for parity, but are good additions in the SwiftUI version:

- Files app import
- Share Sheet import
- AirDrop support
- drag and drop on iPad

Recommended positioning:

- browser upload remains the primary documented workflow
- native import methods are offered as convenience features

## Edge Cases and Rules

- if IP cannot be detected, server may still be running; UI should explain this
- if a subtitle row is tapped and no matching video exists, do nothing or show a gentle message
- if upload completes with duplicate name, preserve file by renaming instead of overwriting
- if playback state file is corrupt, recover gracefully with empty state
- if thumbnail generation fails, show fallback UI instead of blocking playback
- if app wakes from sleep in player, remain paused and unlocked
- if controls are locked and hidden, gestures must still work on the background

## Suggested Acceptance Checklist

### Upload

- can start, stop, and restart local server
- browser page opens from another device on same LAN
- uploads at least one supported video
- uploads multiple files sequentially
- rejects unsupported files cleanly

### Library

- shows uploaded videos and subtitles
- long press anywhere on row enters selection mode
- can bulk delete selected items
- `Clear playback` resets playback badges and positions

### Player

- opens in landscape
- loads saved position
- loads matching subtitle automatically
- single tap toggles controls
- one-finger double tap toggles play/pause
- two-finger double tap toggles lock state
- lock mode hides all controls except lock button when visible
- lock button auto-hides during playback
- single tap works in locked mode
- scrub preview popup appears and seek commits on release
- `Next` advances to next video
- player pauses on sleep/background and stays paused on wake

### Persistence

- playback progress survives app relaunch
- durations persist
- thumbnails are reused
- deletes remove associated playback and thumbnail state

## Recommended Build Order for SwiftUI Rebuild

1. Models and filesystem services
2. Playback state persistence
3. Library screen and media list
4. Basic player with `AVPlayer`
5. Subtitle parsing and overlay
6. Custom controls and gestures
7. Scrub preview thumbnails
8. Local HTTP upload server
9. Browser upload page
10. Polish, interruption handling, and parity fixes

## Final Recommendation

For the SwiftUI rebuild, preserve behavioral parity first, especially:

- upload server workflow
- subtitle matching
- playback resume
- player gestures and lock mode

Then add iOS-native import enhancements as secondary features without changing the core mental model of the app.
