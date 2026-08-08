/**
 * One asset track row: name · sample · preview · shuffle · lock · mute ·
 * FX drawer toggle · delete, plus kind-specific accessories (riser
 * end-alignment warning badge, shot beat-offset stepper).
 *
 * The Lock toggle is the "audition FX presets" affordance: locked rows are
 * exempt from EVERY rotation path (manual shuffle, Shuffle All, and the
 * scene-duplication auto-rotate), so the same sample repeats verbatim.
 */

import React from 'react';
import type { PluginHost } from '@signalsandsorcery/plugin-sdk';
import { TrackExternalFxSection } from '@signalsandsorcery/plugin-sdk';
import { mediumOf, type MixAssetMeta } from '../mix-asset-meta';
import { SoundDrawer } from './SoundDrawer';
import { palette, styles } from './styles';

export interface AssetRowProps {
  host: PluginHost;
  /** Engine track id (for FX drawer + engine ops routed by the panel). */
  trackId: string;
  trackName: string;
  meta: MixAssetMeta;
  /** Round robin: this member plays the current rotation (others are muted). */
  active?: boolean;
  muted: boolean;
  busy: boolean;
  previewing: boolean;
  fxOpen: boolean;
  /** MIDI rows only: whether the sound (instrument-pick) drawer is open. */
  soundOpen?: boolean;
  /** Max legal shot offset for the current scene geometry. */
  maxOffsetBeats: number;
  onPreviewToggle: () => void;
  onShuffle: () => void;
  onLockToggle: () => void;
  onMuteToggle: () => void;
  onFxToggle: () => void;
  onDelete: () => void;
  onOffsetChange?: (beats: number) => void;
  /** MIDI rows only: toggle the sound drawer. */
  onSoundToggle?: () => void;
  /** MIDI rows only: a new instrument was loaded from the sound drawer. */
  onInstrumentChanged?: (name: string) => void;
}

function btnStyle(active?: boolean, disabled?: boolean): React.CSSProperties {
  return {
    ...styles.iconButton,
    ...(active ? styles.iconButtonActive : {}),
    ...(disabled ? styles.iconButtonDisabled : {}),
  };
}

export function AssetRow(props: AssetRowProps): React.ReactElement {
  const { meta } = props;
  const isMidi = mediumOf(meta) === 'midi';
  const hasSample = Boolean(meta.samplePath);

  return (
    <>
      <div
        style={{ ...styles.row, ...(props.active ? styles.rowActive : {}) }}
        data-testid={`mix-asset-row-${props.trackName}`}
      >
        {props.active && (
          <span
            style={styles.activeDot}
            title="Plays this rotation — same-kind assets round-robin, one at a time (advances on stop)"
          >
            ●
          </span>
        )}
        <span style={styles.rowName}>{props.trackName}</span>
        <span
          style={{
            ...styles.rowSample,
            ...(hasSample || isMidi ? {} : styles.rowSampleMissing),
          }}
          title={meta.samplePath ?? undefined}
        >
          {meta.sampleName ?? (isMidi ? 'Surge XT — default patch' : 'no sample — shuffle to assign')}
        </span>

        {meta.kind === 'riser' && meta.truncated && (
          <span style={styles.warnBadge} title="Sample is longer than the scene — it starts on the downbeat; its end is NOT aligned to the loop boundary.">
            too long
          </span>
        )}

        {meta.kind === 'shot' && props.onOffsetChange && (
          <span style={styles.offsetStepper} title="Note start, in quarter-note beats from the scene start">
            beat
            <input
              type="number"
              style={styles.offsetInput}
              min={0}
              max={props.maxOffsetBeats}
              step={0.25}
              value={meta.offsetBeats ?? 0}
              onChange={(e) => props.onOffsetChange?.(Number(e.target.value))}
            />
          </span>
        )}

        {!isMidi && (
          <button
            type="button"
            style={btnStyle(props.previewing, !hasSample)}
            disabled={!hasSample}
            title="Preview the sample"
            onClick={props.onPreviewToggle}
          >
            {props.previewing ? '■' : '▶'}
          </button>
        )}
        <button
          type="button"
          style={btnStyle(false, meta.locked || props.busy)}
          disabled={meta.locked || props.busy}
          title={
            meta.locked
              ? 'Locked — unlock to shuffle'
              : isMidi
                ? 'Shuffle to another synth preset (Surge XT only)'
                : 'Shuffle to another sample'
          }
          onClick={props.onShuffle}
        >
          🎲
        </button>
        {isMidi && props.onSoundToggle && (
          <button
            type="button"
            style={btnStyle(props.soundOpen)}
            title="Pick the sound: load a different instrument (rompler / synth) or open its editor"
            onClick={props.onSoundToggle}
          >
            🎹
          </button>
        )}
        <button
          type="button"
          style={btnStyle(meta.locked)}
          title={
            meta.locked
              ? 'Locked: this sample never auto-rotates (repeats verbatim while you audition FX). Click to unlock.'
              : 'Lock this sample so it never auto-rotates'
          }
          onClick={props.onLockToggle}
        >
          {meta.locked ? '🔒' : '🔓'}
        </button>
        <button
          type="button"
          style={btnStyle(props.muted)}
          title={props.muted ? 'Unmute' : 'Mute'}
          onClick={props.onMuteToggle}
        >
          M
        </button>
        <button
          type="button"
          style={btnStyle(props.fxOpen)}
          title="Track FX (VST/AU inserts — baked into the frozen asset at arranger push)"
          onClick={props.onFxToggle}
        >
          FX
        </button>
        <button
          type="button"
          style={{ ...styles.iconButton, color: palette.danger }}
          title="Delete this asset track"
          onClick={props.onDelete}
        >
          ✕
        </button>
      </div>
      {props.soundOpen && props.onInstrumentChanged && (
        <SoundDrawer
          host={props.host}
          trackId={props.trackId}
          onInstrumentChanged={props.onInstrumentChanged}
        />
      )}
      {props.fxOpen && (
        <div style={styles.fxDrawer}>
          <TrackExternalFxSection host={props.host} trackId={props.trackId} />
        </div>
      )}
    </>
  );
}
