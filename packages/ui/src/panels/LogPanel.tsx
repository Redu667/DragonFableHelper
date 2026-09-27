import { useEffect, useRef } from 'react';
import type { LogEntry, TraceEntry } from '@dfh/core';

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function LogPanel({ entries, onClear }: { entries: readonly LogEntry[]; onClear: () => void }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length]);

  return (
    <div>
      <div className="row tight" style={{ marginBottom: 8 }}>
        <div className="hint" style={{ margin: 0 }}>{entries.length} entries</div>
        <button onClick={onClear}>Clear</button>
      </div>
      <div className="log">
        {entries.length === 0 && <div className="empty">Nothing logged yet.</div>}
        {entries.map((entry, index) => (
          <div key={index} className={entry.level}>
            <time>{clock(entry.timestamp)}</time>
            {entry.message}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

export function TracePanel({ entries }: { entries: readonly TraceEntry[] }) {
  return (
    <div className="log trace">
      <div className="hint" style={{ marginBottom: 8 }}>
        Every call between the bot and the game client, newest last.
      </div>
      {entries.length === 0 && <div className="empty">No traffic yet.</div>}
      {entries.map((entry, index) => (
        <div key={index}>
          <time>{clock(entry.timestamp)}</time>
          <span className={`dir ${entry.direction}`}>{entry.direction === 'toGame' ? '>>' : '<<'}</span>
          {entry.kind && entry.kind !== 'call' && <span className="pill" style={{ marginRight: 6 }}>{entry.kind}</span>}
          {entry.label}
          {entry.meta?.status !== undefined && <span className="dir"> {String(entry.meta.status)}</span>}
          {entry.payload !== undefined && entry.payload !== null && (
            <span className="dir"> {JSON.stringify(entry.payload).slice(0, 140)}</span>
          )}
        </div>
      ))}
    </div>
  );
}
