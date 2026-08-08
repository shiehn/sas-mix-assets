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
import type { MixAssetMeta } from '../mix-asset-meta';
import { palette, styles } from './styles';

export interface AssetRowProps {
  host: PluginHost;
  /** Engine track id (for FX drawer + engine ops routed by the panel). */
  trackId: string;
  trackName: string;
  meta: MixAssetMeta;
  muted: boolean;
  busy: boolean;
  previewing: boolean;
  fxOpen: boolean;
  /** Max legal shot offset for the current scene geometry. */
  maxOffsetBeats: number;
  onPreviewToggle: () => void;
  onShuffle: () => void;
  onLockToggle: () => void;
  onMuteToggle: () => void;
  onFxToggle: () => void;
  onDelete: () => void;
  onOffsetChange?: (beats: number) => void;
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
  const hasSample = Boolean(meta.samplePath);

  return (
    <>
      <div style={styles.row} data-testid={`mix-asset-row-${props.trackName}`}>
        <span style={styles.rowName}>{props.trackName}</span>
        <span
          style={{
            ...styles.rowSample,
            ...(hasSample ? {} : styles.rowSampleMissing),
          }}
          title={meta.samplePath ?? undefined}
        >
          {meta.sampleName ?? 'no sample — shuffle to assign'}
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

        <button
          type="button"
          style={btnStyle(props.previewing, !hasSample)}
          disabled={!hasSample}
          title="Preview the sample"
          onClick={props.onPreviewToggle}
        >
          {props.previewing ? '■' : '▶'}
        </button>
        <button
          type="button"
          style={btnStyle(false, meta.locked || props.busy)}
          disabled={meta.locked || props.busy}
          title={meta.locked ? 'Locked — unlock to shuffle' : 'Shuffle to another sample'}
          onClick={props.onShuffle}
        >
          🎲
        </button>
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
      {props.fxOpen && (
        <div style={styles.fxDrawer}>
          <TrackExternalFxSection host={props.host} trackId={props.trackId} />
        </div>
      )}
    </>
  );
}
