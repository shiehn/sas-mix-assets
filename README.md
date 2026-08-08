# @signalsandsorcery/mix-assets

Mix Assets panel for Signals & Sorcery — a per-project palette of one-shot
mix assets the cloud Arranger can place at section seams.

## The three kinds

| Kind | Placement in the scene | Library folders |
|---|---|---|
| **Hit** | one pitch-60 note on the scene downbeat; the openEnded sampler rings the impact to its natural end | `impact`, `hit`, `sub-drop` |
| **Riser** | note positioned so the sample's natural **end** lands exactly on the loop boundary (`start = loopEnd − sampleDuration`, via `host.getAudioFileInfo`) | `riser`, `sweep` |
| **Shot** | note at a user-chosen beat offset — voice samples, scratches, zaps; import your own audio per track | `zap`, `texture`, `downlifter` |

Each kind is its own track group; members are ordinary `fx`-role tracks with
the engine's single-sound sampler, so VST/AU FX inserts work like on any
track and get **baked into the frozen stem at arranger push**.

## Rotation + Lock

Samples rotate through an exclude-history per kind (project-scoped), so a
different variant lands in different scenes — that per-scene variety is the
arranger's placement palette. The per-row **Lock** pins the current sample
against every rotation path (manual shuffle, Shuffle All, scene-duplication
auto-rotate), so the same hit repeats verbatim while you audition FX presets.

## Arranger contract

One scene-scoped plugin_data key per member track:

```
key:   track:<tracks.id>:mixAsset
value: { version: 1, kind, slotIndex, samplePath, sampleName, locked, source,
         offsetBeats?, sampleDurationSeconds?, truncated?, appliedInSceneId }
```

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
