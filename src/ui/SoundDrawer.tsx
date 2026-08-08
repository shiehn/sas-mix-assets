/**
 * Sound drawer for a MIDI asset row — the "pick your own sound" affordance.
 *
 * Lists the engine's scanned VST3/AU synths (plus the default Surge XT) and
 * loads the chosen one via `host.setTrackInstrument`; "Edit sound" opens the
 * current instrument's native editor. Deliberately minimal — the row's 🎲
 * covers Surge preset rotation; this drawer is for switching to a rompler /
 * other synth entirely.
 */

import React, { useEffect, useState } from 'react';
import type { InstrumentDescriptor, PluginHost } from '@signalsandsorcery/plugin-sdk';
import { palette, styles } from './styles';

export interface SoundDrawerProps {
  host: PluginHost;
  trackId: string;
  /** Called with the instrument's display name after a successful load. */
  onInstrumentChanged: (name: string) => void;
}

const SURGE_DEFAULT_LABEL = 'Surge XT (default)';

export function SoundDrawer(props: SoundDrawerProps): React.ReactElement {
  const { host, trackId, onInstrumentChanged } = props;
  const [instruments, setInstruments] = useState<InstrumentDescriptor[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [available, current] = await Promise.all([
          host.getAvailableInstruments(),
          host.getTrackInstrument(trackId),
        ]);
        if (cancelled) return;
        setInstruments(available.filter((i) => !i.missing));
        setCurrentId(current?.pluginId ?? null);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, trackId]);

  const selectInstrument = (inst: InstrumentDescriptor): void => {
    setBusyId(inst.pluginId);
    void (async () => {
      try {
        await host.setTrackInstrument(trackId, inst.pluginId);
        setCurrentId(inst.pluginId);
        onInstrumentChanged(inst.name);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    })();
  };

  return (
    <div style={styles.soundDrawer} data-testid="mix-assets-sound-drawer">
      <div style={styles.soundDrawerHeader}>
        <span style={{ color: palette.textDim }}>
          {currentId === null ? SURGE_DEFAULT_LABEL : 'Custom instrument'}
        </span>
        <button
          type="button"
          style={styles.iconButton}
          title="Open the instrument's native editor to pick / tweak the sound"
          onClick={() => void host.showInstrumentEditor(trackId).catch(() => {})}
        >
          Edit sound
        </button>
      </div>
      {error && <div style={styles.errorBar}>{error}</div>}
      {instruments === null && !error && (
        <div style={{ color: palette.textFaint, padding: '4px 0' }}>Scanning instruments…</div>
      )}
      {instruments !== null && instruments.length === 0 && (
        <div style={{ color: palette.textFaint, padding: '4px 0' }}>
          No VST3/AU synths found — the default Surge XT is always available.
        </div>
      )}
      {instruments !== null && instruments.length > 0 && (
        <div style={styles.soundList}>
          {instruments.map((inst) => (
            <button
              key={inst.pluginId}
              type="button"
              style={{
                ...styles.soundItem,
                ...(inst.pluginId === currentId ? styles.iconButtonActive : {}),
                ...(busyId === inst.pluginId ? styles.iconButtonDisabled : {}),
              }}
              disabled={busyId !== null}
              title={`${inst.manufacturer} — ${inst.type}`}
              onClick={() => selectInstrument(inst)}
            >
              {inst.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
