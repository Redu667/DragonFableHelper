import type { BotOptions } from '@dfh/core';

export interface OptionsPanelProps {
  options: BotOptions;
  onChange: (patch: Partial<BotOptions>) => void;
}

interface NumberFieldProps {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
}

function NumberField({ label, hint, value, onChange }: NumberFieldProps) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        inputMode="numeric"
        value={String(value)}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function OptionsPanel({ options, onChange }: OptionsPanelProps) {
  return (
    <div>
      <NumberField
        label="Action delay (ms)"
        hint="Pause between combat actions. Very low values hammer the client."
        value={options.actionDelayMs}
        onChange={(actionDelayMs) => onChange({ actionDelayMs })}
      />
      <NumberField
        label="Rest below HP %"
        hint="0 disables resting."
        value={options.restBelowHpPercent}
        onChange={(restBelowHpPercent) => onChange({ restBelowHpPercent })}
      />
      <NumberField
        label="Rest below MP %"
        value={options.restBelowMpPercent}
        onChange={(restBelowMpPercent) => onChange({ restBelowMpPercent })}
      />
      <NumberField
        label="Potion below HP %"
        hint="0 disables. Set the potion item id below."
        value={options.usePotionBelowHpPercent}
        onChange={(usePotionBelowHpPercent) => onChange({ usePotionBelowHpPercent })}
      />
      <NumberField
        label="Potion item id"
        value={options.potionItemId ?? 0}
        onChange={(potionItemId) => onChange({ potionItemId: potionItemId || undefined })}
      />
      <NumberField
        label="Flee below HP %"
        hint="0 disables fleeing."
        value={options.fleeBelowHpPercent}
        onChange={(fleeBelowHpPercent) => onChange({ fleeBelowHpPercent })}
      />
      <NumberField
        label="Wave gap (ms)"
        hint="How long to wait for the next battle of a multi-wave quest."
        value={options.waveGapMs}
        onChange={(waveGapMs) => onChange({ waveGapMs })}
      />

      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', fontSize: 13 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={options.stopOnDeath}
            onChange={(e) => onChange({ stopOnDeath: e.target.checked })}
          />
          Stop the script when I die
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', fontSize: 13 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={options.skipCutscenes}
            onChange={(e) => onChange({ skipCutscenes: e.target.checked })}
          />
          Skip cutscenes automatically
        </label>
      </div>
    </div>
  );
}
