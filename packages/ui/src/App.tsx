import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { GrindPlan } from '@dfh/core';
import type { RufflePlayerElement } from '@dfh/bridge-ruffle';
import { BotSession, type BridgeKind } from './session.js';
import { GameStage } from './panels/GameStage.js';
import { StatusPanel } from './panels/StatusPanel.js';
import { GrindPanel } from './panels/GrindPanel.js';
import { ScriptPanel } from './panels/ScriptPanel.js';
import { LogPanel, TracePanel } from './panels/LogPanel.js';
import { OptionsPanel } from './panels/OptionsPanel.js';
import { LivePanel } from './panels/LivePanel.js';

const TABS = ['Status', 'Grind', 'Script', 'Live', 'Log', 'Trace', 'Options'] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const session = useMemo(() => new BotSession('mock'), []);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [tab, setTab] = useState<Tab>('Status');

  // Connect the default (mock) bridge so the app is usable immediately, and
  // make the session reachable from DevTools: `dfhSession.live.probe()` is
  // the quickest way to see what the live bridge has learned.
  useEffect(() => {
    (window as unknown as { dfhSession: BotSession }).dfhSession = session;
    void session.connect();
  }, [session]);

  const onPlayerReady = useCallback(
    (player: RufflePlayerElement) => {
      void session.useBridge('ruffle', player).then(() => session.connect());
    },
    [session],
  );

  const onStageError = useCallback(
    (message: string) => session.setBridgeError(`Could not load the game: ${message}`),
    [session],
  );

  const switchBridge = (kind: BridgeKind) => {
    if (kind === view.bridgeKind) return;
    if (kind === 'mock') void session.useBridge('mock').then(() => session.connect());
    // Switching to 'ruffle' happens when the stage finishes mounting.
    else session.setPendingLive();
  };

  const runScript = (code: string) => {
    void session.runScript({ id: 'editor', name: 'editor script', code });
  };

  const startGrind = (plan: GrindPlan) => void session.startGrind(plan);
  const stop = () => void session.stop();

  const busy = view.scriptStatus === 'running' || view.scriptStatus === 'stopping';

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">DragonFableHelper</span>

        <span className={`pill ${view.connected ? 'on' : 'off'}`}>
          {view.connected ? 'connected' : 'disconnected'}
        </span>
        <span className={`pill ${busy ? 'busy' : ''}`}>{view.scriptStatus}</span>

        <div className="spacer" />

        <select
          style={{ width: 'auto' }}
          value={view.bridgeKind}
          onChange={(e) => switchBridge(e.target.value as BridgeKind)}
        >
          <option value="mock">Bridge: Mock game</option>
          <option value="ruffle">Bridge: Ruffle (live)</option>
        </select>

        <button onClick={() => void session.connect()} disabled={busy}>Connect</button>
        <button className="danger" onClick={stop} disabled={!busy}>Stop</button>
      </header>

      <div className="layout">
        <GameStage
          live={view.bridgeKind === 'ruffle' || view.pendingLive}
          onPlayerReady={onPlayerReady}
          onError={onStageError}
        />

        <aside className="side">
          <nav className="tabs" role="tablist">
            {TABS.map((name) => (
              <button key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
                {name}
              </button>
            ))}
          </nav>

          <div className="panel" role="tabpanel">
            {view.error && <div className="banner">{view.error}</div>}

            {tab === 'Status' && <StatusPanel snapshot={view.snapshot} />}
            {tab === 'Grind' && (
              <GrindPanel
                status={view.scriptStatus}
                progress={view.grind}
                onStart={startGrind}
                onStop={stop}
                disabled={!view.connected}
              />
            )}
            {tab === 'Script' && (
              <ScriptPanel status={view.scriptStatus} onRun={runScript} onStop={stop} disabled={!view.connected} />
            )}
            {tab === 'Live' && (
              <LivePanel
                discovery={view.discovery}
                calibrating={view.calibrating}
                isLive={view.bridgeKind === 'ruffle'}
                binding={session.live?.currentProfile.combat ?? {}}
                onRefresh={() => session.refreshDiscovery()}
                onCalibrateClick={(a) => void session.calibrateClick(a)}
                onCalibratePoint={(n) => void session.calibratePointSensor(n)}
                onCalibrateBar={(n) => void session.calibrateBarSensor(n)}
                onCancel={() => session.cancelCalibration()}
                onRemoveSensor={(n) => session.removeSensor(n)}
                onSetCallbacks={(names) => session.setCallbackNames(names)}
                onSetBinding={(b) => session.setCombatBinding(b)}
              />
            )}
            {tab === 'Log' && <LogPanel entries={view.logs} onClear={() => session.clearLogs()} />}
            {tab === 'Trace' && <TracePanel entries={view.traces} />}
            {tab === 'Options' && <OptionsPanel options={view.options} onChange={(p) => session.setOptions(p)} />}
          </div>
        </aside>
      </div>
    </div>
  );
}
