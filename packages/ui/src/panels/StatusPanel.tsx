import type { GameSnapshot } from '@dfh/core';

function pct(value: number, max: number): number {
  return max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
}

export function StatusPanel({ snapshot }: { snapshot: GameSnapshot }) {
  const { player, combat } = snapshot;

  if (!snapshot.loggedIn) {
    return <div className="empty">Not in game yet. Connect a bridge and log in to see player state.</div>;
  }

  return (
    <div>
      <div className="stat-grid">
        <div className="stat">
          <div className="k">{player.name || 'Hero'}</div>
          <div className="v">Level {player.level}</div>
        </div>
        <div className="stat">
          <div className="k">Class</div>
          <div className="v" style={{ fontSize: 14 }}>{player.className || '-'}</div>
        </div>
        <div className="stat">
          <div className="k">HP</div>
          <div className="v">{player.hp} / {player.maxHp}</div>
          <div className="bar hp"><span style={{ width: `${pct(player.hp, player.maxHp)}%` }} /></div>
        </div>
        <div className="stat">
          <div className="k">MP</div>
          <div className="v">{player.mp} / {player.maxMp}</div>
          <div className="bar mp"><span style={{ width: `${pct(player.mp, player.maxMp)}%` }} /></div>
        </div>
        <div className="stat">
          <div className="k">Gold</div>
          <div className="v">{player.gold.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="k">Location</div>
          <div className="v" style={{ fontSize: 14 }}>{player.location || '-'}</div>
        </div>
      </div>

      <div className="field">
        <label>Combat</label>
        {combat.inCombat || combat.monsters.length > 0 ? (
          <table className="items">
            <thead>
              <tr><th>Monster</th><th style={{ textAlign: 'right' }}>HP</th></tr>
            </thead>
            <tbody>
              {combat.monsters.map((monster) => (
                <tr key={monster.index} style={{ opacity: monster.alive ? 1 : 0.4 }}>
                  <td>
                    {monster.index === combat.selectedTarget && combat.inCombat ? '> ' : ''}
                    {monster.name || `Monster ${monster.index + 1}`}
                  </td>
                  <td className="n">{monster.hp}{monster.maxHp ? ` / ${monster.maxHp}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="hint">Not in combat.</div>
        )}
        {combat.inCombat && <div className="hint">Round {combat.round} - {combat.phase}</div>}
      </div>

      <div className="field">
        <label>Inventory ({snapshot.inventory.length})</label>
        {snapshot.inventory.length === 0 ? (
          <div className="hint">Empty, or not readable from this bridge.</div>
        ) : (
          <table className="items">
            <tbody>
              {snapshot.inventory.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}{item.equipped ? ' (equipped)' : ''}</td>
                  <td className="n">{item.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
