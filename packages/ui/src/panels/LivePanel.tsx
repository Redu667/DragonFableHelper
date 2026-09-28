import { useState } from 'react';
import { INPUT_ACTIONS, type CallbackAction, type CallbackNames, type CombatSensorBinding, type DiscoveryReport } from '@dfh/bridge-ruffle';

const CALLBACK_ACTIONS: CallbackAction[] = [
  'attack', 'useSkill', 'selectTarget', 'flee', 'acknowledge', 'rest', 'skipCutscene',
  'acceptQuest', 'turnInQuest', 'loadQuest', 'abandonQuest', 'equipItem', 'useItem',
  'loadShop', 'buyItem', 'sellItem', 'travelTown', 'travelHub',
];

export interface LivePanelProps {
  discovery: DiscoveryReport | null;
  calibrating: string | null;
  isLive: boolean;
  binding: CombatSensorBinding;
  onRefresh: () => void;
  onCalibrateClick: (action: string) => void;
  onCalibratePoint: (name: string) => void;
  onCalibrateBar: (name: string) => void;
  onCancel: () => void;
  onRemoveSensor: (name: string) => void;
  onSetCallbacks: (names: CallbackNames) => void;
  onSetBinding: (binding: CombatSensorBinding) => void;
}

/**
 * Everything the live bridge has learned about the running client, and the
 * controls to teach it the rest. Nothing on this panel is a guess: callbacks
 * are what the movie registered, endpoints are what it really called, and
 * every position and sensor was clicked into place by you.
 */
export function LivePanel(props: LivePanelProps) {
  const { discovery, calibrating, isLive, binding } = props;
  const [pointName, setPointName] = useState('playerTurn');
  const [barName, setBarName] = useState('monster0');
  const [names, setNames] = useState<CallbackNames>(discovery?.callbacksConfigured ?? {});

  if (!isLive) {
    return (
      <div className="empty">
        The Live panel drives the real client. Switch the bridge to <strong>Ruffle (live)</strong> in the
        top bar; the mock game has nothing to discover.
      </div>
    );
  }

  if (!discovery) return <div className="empty">Waiting for the bridge to connect...</div>;

  const endpoints = Object.entries(discovery.endpoints);
  const pointSensors = discovery.sensors;

  return (
    <div>
      {calibrating && (
        <div className="banner" style={{ background: '#2f3d1f', borderColor: '#4a6a2a' }}>
          {calibrating}
          <div className="row tight" style={{ marginTop: 8 }}>
            <span className="hint" style={{ margin: 0 }}>Waiting for your click on the game...</span>
            <button onClick={props.onCancel}>Cancel</button>
          </div>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat"><div className="k">Movie</div><div className="v" style={{ fontSize: 14 }}>{readyStateLabel(discovery.readyState)}</div></div>
        <div className="stat"><div className="k">Logged in</div><div className="v" style={{ fontSize: 14 }}>{discovery.loggedIn ? 'yes' : 'not yet'}</div></div>
        <div className="stat"><div className="k">Server calls seen</div><div className="v">{discovery.exchanges}</div></div>
        <div className="stat"><div className="k">trace() lines</div><div className="v">{discovery.traceLines}</div></div>
      </div>

      <div className="row tight" style={{ marginBottom: 12 }}>
        <div className="hint" style={{ margin: 0 }}>Updates as the game talks to its server.</div>
        <button onClick={props.onRefresh}>Refresh</button>
      </div>

      <div className="field">
        <label>Server endpoints</label>
        {endpoints.length === 0 ? (
          <div className="hint">Nothing yet. Log in to the game and the replies will be listed here with the field names they carry.</div>
        ) : (
          <table className="items">
            <thead><tr><th>Endpoint</th><th>Calls</th><th>Status</th><th>Feeds</th></tr></thead>
            <tbody>
              {endpoints.map(([name, info]) => (
                <tr key={name} title={`Fields: ${info.keys.join(', ') || 'none parsed'}`}>
                  <td>{name}</td>
                  <td className="n">{info.calls}</td>
                  <td className="n">{info.lastStatus}</td>
                  <td>{info.matched.length ? info.matched.join(', ') : <span className="hint">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="hint">Hover a row for every field name in its reply. A field the bot needs but is not listed under "Feeds" needs an alias in the profile.</div>
      </div>

      <div className="field">
        <label>ExternalInterface callbacks</label>
        {discovery.callbacksFound.length === 0 ? (
          <div className="hint">The movie has registered no callbacks. Actions will use recorded click positions instead.</div>
        ) : (
          <>
            <div className="hint" style={{ marginBottom: 6 }}>Found: {discovery.callbacksFound.join(', ')}</div>
            {CALLBACK_ACTIONS.map((action) => (
              <div className="row" key={action} style={{ marginBottom: 4 }}>
                <span style={{ flex: '0 0 110px', fontSize: 12.5 }}>{action}</span>
                <select
                  value={names[action] ?? ''}
                  onChange={(e) => setNames({ ...names, [action]: e.target.value || undefined })}
                >
                  <option value="">(none)</option>
                  {discovery.callbacksFound.map((cb) => <option key={cb} value={cb}>{cb}</option>)}
                </select>
              </div>
            ))}
            <button onClick={() => props.onSetCallbacks(names)}>Save callback mapping</button>
          </>
        )}
      </div>

      <div className="field">
        <label>Click positions</label>
        <div className="hint" style={{ marginBottom: 6 }}>
          Press Record, then click that button in the game. The bot clicks the same spot.
        </div>
        <table className="items">
          <tbody>
            {INPUT_ACTIONS.map((action) => {
              const recorded = discovery.inputRecorded.includes(action);
              return (
                <tr key={action}>
                  <td>{action}</td>
                  <td className="n">
                    <span className={`pill ${recorded ? 'on' : 'off'}`}>{recorded ? 'recorded' : 'missing'}</span>
                  </td>
                  <td className="n"><button onClick={() => props.onCalibrateClick(action)} disabled={!!calibrating}>Record</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="field">
        <label>Pixel sensors</label>
        <div className="hint" style={{ marginBottom: 6 }}>
          Battles happen inside the client, so whose turn it is and monster HP never reach the server. Sample the
          pixels that show them instead.
        </div>
        {pointSensors.length > 0 && (
          <table className="items" style={{ marginBottom: 8 }}>
            <tbody>
              {pointSensors.map((name) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td className="n">{readingFor(discovery, name)}</td>
                  <td className="n"><button onClick={() => props.onRemoveSensor(name)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row tight" style={{ marginBottom: 6 }}>
          <input value={pointName} onChange={(e) => setPointName(e.target.value)} placeholder="on/off sensor name" />
          <button onClick={() => props.onCalibratePoint(pointName)} disabled={!!calibrating || !pointName}>Sample point</button>
        </div>
        <div className="row tight">
          <input value={barName} onChange={(e) => setBarName(e.target.value)} placeholder="bar sensor name" />
          <button onClick={() => props.onCalibrateBar(barName)} disabled={!!calibrating || !barName}>Sample bar</button>
        </div>
      </div>

      <div className="field">
        <label>What the sensors mean</label>
        <BindingRow label="Player's turn" value={binding.playerTurn} options={pointSensors} onChange={(v) => props.onSetBinding({ ...binding, playerTurn: v })} />
        <BindingRow label="In combat" value={binding.inCombat} options={pointSensors} onChange={(v) => props.onSetBinding({ ...binding, inCombat: v })} />
        <BindingRow label="Victory screen" value={binding.victory} options={pointSensors} onChange={(v) => props.onSetBinding({ ...binding, victory: v })} />
        <BindingRow label="Defeat screen" value={binding.defeat} options={pointSensors} onChange={(v) => props.onSetBinding({ ...binding, defeat: v })} />
        <BindingRow label="Player HP bar" value={binding.playerHp} options={pointSensors} onChange={(v) => props.onSetBinding({ ...binding, playerHp: v })} />
        <div className="row" style={{ marginBottom: 4 }}>
          <span style={{ flex: '0 0 110px', fontSize: 12.5 }}>Monster HP bars</span>
          <input
            placeholder="bar names, in slot order, comma separated"
            defaultValue={(binding.monsterHp ?? []).join(', ')}
            onBlur={(e) => props.onSetBinding({ ...binding, monsterHp: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          />
        </div>
      </div>
    </div>
  );
}

function BindingRow({ label, value, options, onChange }: { label: string; value?: string; options: string[]; onChange: (v: string | undefined) => void }) {
  return (
    <div className="row" style={{ marginBottom: 4 }}>
      <span style={{ flex: '0 0 110px', fontSize: 12.5 }}>{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">(unset)</option>
        {options.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </div>
  );
}

function readingFor(discovery: DiscoveryReport, name: string): string {
  const reading = discovery.lastSensorReading;
  if (!reading) return '-';
  if (name in reading.points) return reading.points[name] ? 'on' : 'off';
  if (name in reading.bars) return `${Math.round((reading.bars[name] ?? 0) * 100)}%`;
  return '-';
}

function readyStateLabel(state: number | null): string {
  switch (state) {
    case 0: return 'not loaded';
    case 1: return 'loading';
    case 2: return 'loaded';
    default: return 'unknown';
  }
}
