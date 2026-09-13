import { useState } from 'react';
import type { GrindPlan, GrindProgress, ScriptStatus } from '@dfh/core';

export interface GrindPanelProps {
  status: ScriptStatus;
  progress: GrindProgress | null;
  onStart: (plan: GrindPlan) => void;
  onStop: () => void;
  disabled: boolean;
}

export function GrindPanel({ status, progress, onStart, onStop, disabled }: GrindPanelProps) {
  const [questId, setQuestId] = useState('1');
  const [rotation, setRotation] = useState('3:mobs>1 | 2 | 1');
  const [itemName, setItemName] = useState('');
  const [itemQty, setItemQty] = useState('10');
  const [runs, setRuns] = useState('');
  const [turnIn, setTurnIn] = useState(true);
  const [stopOnDeath, setStopOnDeath] = useState(true);

  const running = status === 'running' || status === 'stopping';

  const start = () => {
    const plan: GrindPlan = {
      questId: Number(questId) || 0,
      rotation: rotation.trim() || undefined,
      turnIn,
      stopOnDeath,
      restBetweenRuns: true,
    };
    if (itemName.trim()) plan.until = [{ item: itemName.trim(), quantity: Number(itemQty) || 1 }];
    if (runs.trim()) plan.runs = Number(runs);
    onStart(plan);
  };

  const elapsed = progress
    ? Math.max(0, ((progress.finishedAt ?? Date.now()) - progress.startedAt) / 1000)
    : 0;

  return (
    <div>
      <div className="field">
        <label>Quest ID</label>
        <input value={questId} onChange={(e) => setQuestId(e.target.value)} inputMode="numeric" />
      </div>

      <div className="field">
        <label>Skill rotation</label>
        <input value={rotation} onChange={(e) => setRotation(e.target.value)} />
        <div className="hint">
          Slots in priority order. Guards: <code>hp&lt;40</code>, <code>mobs&gt;1</code>,{' '}
          <code>every2</code>, <code>max1</code>, <code>target&lt;30</code>.
        </div>
      </div>

      <div className="field">
        <label>Stop when I have</label>
        <div className="row">
          <input placeholder="item name (optional)" value={itemName} onChange={(e) => setItemName(e.target.value)} />
          <input style={{ maxWidth: 80 }} value={itemQty} onChange={(e) => setItemQty(e.target.value)} inputMode="numeric" />
        </div>
        <div className="hint">Leave blank to grind until you stop it, or set a run limit below.</div>
      </div>

      <div className="field">
        <label>Run limit (optional)</label>
        <input value={runs} onChange={(e) => setRuns(e.target.value)} inputMode="numeric" placeholder="unlimited" />
      </div>

      <div className="field row" style={{ gap: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 13 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={turnIn} onChange={(e) => setTurnIn(e.target.checked)} />
          Turn quest in
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 13 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={stopOnDeath} onChange={(e) => setStopOnDeath(e.target.checked)} />
          Stop on death
        </label>
      </div>

      <div className="row tight">
        <button className="primary" onClick={start} disabled={running || disabled}>
          {running ? 'Running...' : 'Start grind'}
        </button>
        <button className="danger" onClick={onStop} disabled={!running}>Stop</button>
      </div>

      {progress && (
        <div className="stat-grid" style={{ marginTop: 14 }}>
          <div className="stat"><div className="k">Runs</div><div className="v">{progress.runs}</div></div>
          <div className="stat"><div className="k">Turned in</div><div className="v">{progress.completed}</div></div>
          <div className="stat"><div className="k">Battles</div><div className="v">{progress.battlesFought}</div></div>
          <div className="stat"><div className="k">Deaths</div><div className="v">{progress.deaths}</div></div>
          <div className="stat"><div className="k">Gold</div><div className="v">{progress.goldGained.toLocaleString()}</div></div>
          <div className="stat">
            <div className="k">Gold / hr</div>
            <div className="v">{elapsed > 5 ? Math.round((progress.goldGained / elapsed) * 3600).toLocaleString() : '-'}</div>
          </div>
        </div>
      )}

      {progress && Object.keys(progress.itemsGained).length > 0 && (
        <div className="field" style={{ marginTop: 12 }}>
          <label>Drops this grind</label>
          <table className="items">
            <tbody>
              {Object.entries(progress.itemsGained).map(([name, qty]) => (
                <tr key={name}><td>{name}</td><td className="n">+{qty}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {progress?.stoppedReason && (
        <div className="hint" style={{ marginTop: 10 }}>Stopped: {progress.stoppedReason}</div>
      )}
    </div>
  );
}
