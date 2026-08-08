# @signalsandsorcery/mix-assets

Mix Assets panel for Signals & Sorcery — a per-project palette of one-shot
mix assets the cloud Arranger can place at section seams. Two families,
divided in the panel: **MIDI** (top) and **Audio samples** (bottom).

## MIDI family (top section)

Hits / Risers / Shots as ordinary instrument tracks (Surge XT by default —
swap in any rompler/synth via the row's 🎹 drawer, or open its native editor)
carrying one **deterministic** root note. No LLM is involved:

| Kind | Note written |
|---|---|
| **MIDI Hit** | the root, quarter note on the scene downbeat (16+ bar scenes add a second hit at the loop midpoint) |
| **MIDI Riser** | the root held across the **last bar** of the loop |
| **MIDI Shot** | the root, quarter note at a user-chosen beat offset |

The root pitch **doubles the scene's first bass note** (first `role='bass'`
track with MIDI, earliest note, octave included) and falls back to the
downbeat chord's root — else the key tonic — in the bass octave. The row's 🎲
rotates the Surge preset through the same exclude-history model the audio
rows use for samples (custom instruments keep their own patch — change it in
the instrument's editor instead).

## Audio family (bottom section) — the three kinds

| Kind | Placement in the scene | Library folders |
|---|---|---|
| **Hit** | one pitch-60 note on the scene downbeat (16+ bar scenes add a second hit at the loop midpoint); the openEnded sampler rings the impact to its natural end | `impact`, `hit`, `sub-drop` |
| **Riser** | note positioned so the sample's natural **end** lands exactly on the loop boundary (`start = loopEnd − sampleDuration`, via `host.getAudioFileInfo`) | `riser`, `sweep` |
| **Shot** | note at a user-chosen beat offset — voice samples, scratches, zaps; import your own audio per track | `zap`, `texture`, `downlifter` |

Each kind × family is its own track group; members are ordinary `fx`-role
tracks (audio: the engine's single-sound sampler; MIDI: a real instrument),
so VST/AU FX inserts work like on any track and get **baked into the frozen
stem at arranger push** — freezing needs nothing plugin-specific.

## Rotation + Lock

Sounds rotate through an exclude-history per kind (project-scoped; MIDI
presets use a parallel `midi:<kind>` deck), so a different variant lands in
different scenes — that per-scene variety is the arranger's placement
palette. The per-row **Lock** pins the current sound against every rotation
path (manual shuffle, Shuffle All, scene-duplication auto-rotate), so the
same hit repeats verbatim while you audition FX presets.

## Round robin — one asset per kind at a time

Members of a kind — **MIDI and audio together** (a MIDI hit and a sample hit
are alternatives, never layered) — form one rotation pool. Exactly one
member per kind is audible (accent-marked ●); the rest are engine-muted. The
pointer advances one step on every transport **stop**, so successive
playthroughs cycle the pool, and a freshly added asset takes the active slot
so you hear it immediately. State lives in the scene-scoped `roundRobin`
plugin_data key.

The mutes are **engine-only by design** — the DB `muted` column is never
written, because the arranger push drops DB-muted layers and every variant
must keep reaching the cloud palette (the arranger brain already places at
most one asset of a kind at a time). Corollary: enforcement happens while
the Mix Assets panel is open; after a fresh app start the mutes re-apply
when the panel first mounts for the scene.

## Arranger contract

One scene-scoped plugin_data key per member track:

```
key:   track:<tracks.id>:mixAsset
value: { version: 1, kind, medium?, slotIndex, samplePath, sampleName, locked,
         source, offsetBeats?, rootPitch?, sampleDurationSeconds?, truncated?,
         appliedInSceneId }
```

`medium` is `'midi' | 'audio'`, absent = `'audio'` (pre-MIDI metas parse
unchanged). For MIDI rows `samplePath` is always null and `sampleName`
carries the current preset / instrument display name.

The arranger push service reads this (main-side, plugin not running) to tag
the frozen per-scene stems with `asset_kind`, which the cloud brain uses to
place hits/risers/shots — never two of the same kind at once.

## Known v1 limitations

- **Imported samples are per-machine** (they live in the plugin data dir).
  The frozen stems carry the audio to the arranger, but on another machine
  the raw file is missing until re-imported — the row shows a warning.
- **Riser trailing silence**: a sample with encoded tail silence will sound
  early even though its file end is aligned to the boundary.
- A riser longer than the scene is placed on the downbeat instead, with a
  "too long" badge (the pick loop tries up to 5 candidates that fit first).

## Development

```bash
npm install
npm test          # jest — pure placement/rotation/meta/resolver logic
npm run build     # tsup → dist/ (the app consumes dist, not src)
```

Requires host SDK ≥ 2.65.0 (`host.getAudioFileInfo`).
