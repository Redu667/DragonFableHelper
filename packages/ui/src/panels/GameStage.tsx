import { useEffect, useRef, useState } from 'react';
import { fitStage, mountDragonFable, type RufflePlayerElement } from '@dfh/bridge-ruffle';

export interface GameStageProps {
  /** Mount the real client. When false, a placeholder explains the mock. */
  live: boolean;
  onPlayerReady: (player: RufflePlayerElement) => void;
  onError: (message: string) => void;
}

/**
 * Hosts the DragonFable client under Ruffle.
 *
 * The stage is a fixed 750x550 that gets scaled to fit, which is what makes
 * the same view usable on a desktop window and a phone screen.
 */
export function GameStage({ live, onPlayerReady, onError }: GameStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!live || mountedRef.current) return;
    const stage = stageRef.current;
    const wrap = wrapRef.current;
    if (!stage || !wrap) return;

    mountedRef.current = true;
    setLoading(true);
    let disposeFit: (() => void) | undefined;

    mountDragonFable({ container: stage })
      .then((player) => {
        disposeFit = fitStage(stage, wrap);
        setLoading(false);
        onPlayerReady(player);
      })
      .catch((error: unknown) => {
        mountedRef.current = false;
        setLoading(false);
        onError((error as Error).message);
      });

    return () => disposeFit?.();
  }, [live, onPlayerReady, onError]);

  return (
    <div className="stage-wrap" ref={wrapRef}>
      <div className="stage" ref={stageRef} style={{ display: live ? 'block' : 'none' }} />
      {!live && (
        <div className="stage-placeholder">
          <h3 style={{ margin: '0 0 8px' }}>Simulated game</h3>
          <p style={{ margin: 0, fontSize: 13 }}>
            You are on the <strong>mock</strong> bridge: a built-in DragonFable simulator with quests,
            waves, drops, cooldowns and death. Everything - grinds, rotations, scripts - runs against it
            with no game client and no network traffic.
          </p>
          <p style={{ margin: '10px 0 0', fontSize: 13 }}>
            Switch the bridge to <strong>Ruffle</strong> in the top bar to load the real client.
          </p>
        </div>
      )}
      {loading && <div className="stage-placeholder">Loading Ruffle and DFLoader.swf...</div>}
    </div>
  );
}
