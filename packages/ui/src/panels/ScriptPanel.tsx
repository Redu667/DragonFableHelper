import { useState } from 'react';
import type { ScriptStatus } from '@dfh/core';

const EXAMPLE = `// The 'bot' object is your API. Press Run.
bot.log.info('Starting up as ' + bot.player.name);

bot.combat.setRotation('3:mobs>1 | 2 | 1');

await bot.grind({
  questId: 1,
  until: [{ item: 'Sneevil Box', quantity: 10 }],
  turnIn: false,
});

bot.log.info('Done with ' + bot.inventory.count('Sneevil Box') + ' boxes');
`;

export interface ScriptPanelProps {
  status: ScriptStatus;
  onRun: (code: string) => void;
  onStop: () => void;
  disabled: boolean;
}

export function ScriptPanel({ status, onRun, onStop, disabled }: ScriptPanelProps) {
  const [code, setCode] = useState(EXAMPLE);
  const running = status === 'running' || status === 'stopping';

  return (
    <div>
      <div className="field">
        <label>Script</label>
        <textarea rows={16} value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} />
        <div className="hint">
          Plain JavaScript with <code>await</code>. A bare body or{' '}
          <code>export default async (bot) =&gt; {'{}'}</code> both work. Scripts run with the app's own
          permissions - only run scripts you have read.
        </div>
      </div>
      <div className="row tight">
        <button className="primary" onClick={() => onRun(code)} disabled={running || disabled}>Run</button>
        <button className="danger" onClick={onStop} disabled={!running}>Stop</button>
      </div>
      <div className="hint" style={{ marginTop: 8 }}>Status: {status}</div>
    </div>
  );
}
