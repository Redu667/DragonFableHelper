# DragonFableHelper

A scriptable automation client for **DragonFable**, in the spirit of
[Skua](https://github.com/BrenoHenrike/Skua) and Grimlite for AdventureQuest
Worlds: the game runs inside the app, a bridge exposes its state, and your
scripts drive it through a stable API.

Runs on **desktop** (Electron) and **Android** (WebView) from one shared
codebase.

> [!WARNING]
> **Automating DragonFable violates Artix Entertainment's Terms of Service and
> can get your account banned.** This project is published for the engineering
> interest in game-client bridging and scripting. Use it at your own risk, on
> an account you are willing to lose. It is not affiliated with or endorsed by
> Artix Entertainment.

---

## Why it is built this way

DragonFable is a Flash game, and Flash has been dead since 2020. The game still
runs under [Ruffle](https://ruffle.rs), an open-source Flash emulator compiled
to WebAssembly — which means the client runs *in a web page*.

That single fact drives the whole architecture. If the game lives in a web
page, and the bot also lives in that page, then **desktop and mobile are just
two thin shells around the same bundle**:

```
                    ┌─────────────────────────────────────────┐
                    │            @dfh/ui  (React)             │
                    │   Status · Grind · Script · Log · Trace  │
                    ├─────────────────────────────────────────┤
                    │           @dfh/core  (no I/O)           │
                    │  Bot API · rotations · grinder · state   │
                    │  script host · cancellation · logging    │
                    ├────────────────────┬────────────────────┤
                    │   MockBridge       │   RuffleBridge      │
                    │  (simulated game)  │  (the real client)  │
                    └────────────────────┴──────────┬─────────┘
                                                    │ fetch tap · callbacks
                                                    │ clicks · pixel sensors
                                              ┌─────▼─────┐
                                              │ DFLoader  │
                                              │   .swf    │
                                              └───────────┘
     ┌──────────────────────┐        ┌──────────────────────────┐
     │  @dfh/host-electron  │        │    @dfh/host-android     │
     │   desktop window     │        │   WebView, same bundle   │
     └──────────────────────┘        └──────────────────────────┘
```

`@dfh/core` has no DOM, no Node and no Electron in it — which is why it is
covered by 65 fast unit tests, and why the same bot engine runs unchanged on a
phone.

### The origin trick (mobile)

DragonFable's loader fetches assets relative to its own origin, and
`ExternalInterface` — how the bot talks to the game — is gated on script
access. A page on a `file://` origin therefore *cannot* drive the game.

The Android host solves this the way the excellent
[DF Pocket](https://github.com/anthony-hyo/df-mobile) project showed: put the
page at the game's origin. We serve our bundle from
`https://play.dragonfable.com/__dfh/` and intercept exactly that path in
`shouldInterceptRequest`, handing back files from the APK. The page's origin is
the game's origin; the bytes are local. Electron does the equivalent with a
`webRequest` CORS shim.

---

## Downloads

Prerelease builds for macOS, Windows, Linux and Android are published from the
[Prerelease workflow](../../actions/workflows/prerelease.yml) to the
[Releases page](../../releases).

| Platform | File |
| --- | --- |
| macOS (Apple Silicon / Intel) | `*-mac-arm64.dmg` / `*-mac-x64.dmg` |
| Windows | `*-win-x64-setup.exe`, or `*-win-x64-portable.exe` |
| Linux | `*-linux-x86_64.AppImage`, or `*-linux-amd64.deb` |
| Android | `*-android.apk` |

They are **unsigned**, so each OS will object the first time: on macOS
right-click → *Open* (or `xattr -dr com.apple.quarantine` the app), on Windows
choose *More info* → *Run anyway*, and on Android allow installs from unknown
sources. The APK is debug-signed so it is installable but will not upgrade over
a differently-signed build.

## Quickstart

```bash
pnpm install
pnpm --filter @dfh/ui build     # build the web bundle
pnpm --filter @dfh/host-electron start
```

The app opens on the **mock bridge**: a built-in DragonFable simulator with
quests, multi-wave battles, drops, mana, cooldowns, and death. Everything —
grinds, rotations, scripts, the log and the trace inspector — works against it
with **no game client and no network traffic**. Start there; it is the fastest
way to see the bot actually botting.

Switch the bridge selector to **Ruffle (live)** to load the real client.

### Android

```bash
pnpm --filter @dfh/ui build                 # gradle refuses to build without this
cd packages/host-android
gradle wrapper                              # first time only
./gradlew assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/`.

---

## Writing scripts

Scripts are plain JavaScript with `await`. Both shapes work:

```js
export default async function (bot) { /* ... */ }
```
```js
await bot.grind({ questId: 1 });   // bare body, no wrapper
```

The `bot` object:

| Area | What you get |
| --- | --- |
| `bot.player` | `hp`, `hpPercent`, `mp`, `gold`, `level`, `alive`, `rest()`, `restIfNeeded()` |
| `bot.combat` | `active`, `isPlayerTurn`, `attack()`, `useSkill(slot)`, `flee()`, `fight(rotation)`, `waitForCombatEnd()` |
| `bot.quests` | `runOnce(id, opts)`, `accept()`, `turnIn()`, `isCompleted()`, `canTurnIn()` |
| `bot.inventory` | `count(nameOrId)`, `contains()`, `equip()`, `sell()`, `missing(reqs)` |
| `bot.shops` | `load(id)`, `buy(shopId, itemId, qty)` |
| `bot.travel` | `toTown('falconreach')`, `toHub()` |
| `bot.grind(plan)` | The whole repeat-a-quest-until-done loop |
| `bot.options` | Rest/potion/flee thresholds, delays, `stopOnDeath` |
| `bot.log`, `bot.sleep()`, `bot.checkStop()`, `bot.waitUntil()` | Plumbing |

### Rotations

DragonFable's combat is turn-based with mana costs and per-skill cooldowns, so
the rotation engine is conditional rather than a fixed loop. As a string:

```
3:mobs>1 | 4:hp<40 | 2:every2 | 1
```

Read as: *cleave when more than one monster is up; heal below 40% HP; the heavy
hit at most every second round; otherwise attack.* Guards available:
`hp<N`, `hp>N`, `target<N`, `target>N`, `mobs>N`, `everyN`, `maxN`.

Or as objects, when you want a predicate:

```js
bot.combat.setRotation([
  { slot: 4, playerHpBelow: 50 },
  { slot: 5, maxUsesPerBattle: 1 },
  { slot: 3, when: (ctx) => ctx.aliveMonsters.length >= 2 && ctx.round > 1 },
  { slot: 1 },
]);
```

Rules are tried in order; the first one that is both *usable* (off cooldown,
affordable) and *permitted* fires, with a fallback to the basic attack.

See [`scripts/`](./scripts) for worked examples.

---

## The live bridge, and what it can honestly know

Ruffle has **no way to read a movie's ActionScript state from JavaScript** -
no `GetVariable`, nothing. That rules out the obvious "poke `_root.hero.hp`"
design outright, so the live bridge is built only on what Ruffle actually
provides, each verified against Ruffle's source:

| Channel | What Ruffle provides | What the bridge does with it |
| --- | --- | --- |
| **Server traffic** | Every request the movie makes goes through the page's own `window.fetch` | A tap installed before the movie loads records each reply; the extractor parses it (URL-encoded, XML or JSON) and fills the player's name, level, HP/MP, gold, … This is the primary source of state, and it works identically on desktop and Android. |
| **ExternalInterface** | Callbacks the movie registers appear as properties of the player element | Discovered by enumeration and listed in the Live panel; you map them to actions there. |
| **Input** | The wasm listens for pointer events on its canvas | For actions with no callback, the bridge clicks positions you recorded by clicking them once yourself. |
| **Pixels** | The rendered frame is readable | Battles resolve inside the client, so turn and monster HP never touch the network. Sensors you sample from the frame (a lit hotbar, an HP bar) supply them. |
| **`trace()`** | A trace observer | Shown in the Trace panel. |

Nothing about the client is guessed and shipped as fact. What *is* shipped is
a set of field-name aliases following Artix's own conventions (`intHP`,
`intHPMax`, `strUsername`, …), matched case-insensitively against whatever
the replies really contain - and the Live panel shows every field name each
endpoint carried, so a miss is visible rather than silent.

### Setting it up against a real client

1. Switch the bridge to **Ruffle (live)** and log in. Open the **Live** tab.
2. **Server endpoints** fill in as the game talks to its server, with the
   fields each reply carried and which bot fields they fed. If HP or gold
   is not being picked up, the reply's actual key names are right there.
3. **Callbacks**: if the movie registered any, map them to actions and save.
4. **Click positions**: for each action, press *Record* and click that
   button in the game. The bot will click the same spot.
5. **Pixel sensors**: sample the spot that lights up on your turn, the HP
   bars, the victory screen; then tell the bridge what each one means.

Everything you set is persisted (browser storage; on desktop that is the
`app://dfh` origin), so it survives restarts. From DevTools,
`dfhSession.live.probe()` prints the whole discovery report.

Calls the client gives no channel for throw a named `BridgeError` saying
precisely what is missing - "no `rest` callback (found: …) and no click
position for `rest`" - instead of doing nothing.

## Layout

| Package | Contents |
| --- | --- |
| `packages/core` | Bot engine, script API, rotations, grinder, state, mock game. Pure TS. |
| `packages/bridge-ruffle` | Ruffle host, network tap, reply extractor, callback discovery, click input, pixel sensors, persisted profile |
| `packages/ui` | React panels, shared by both hosts |
| `packages/host-electron` | Desktop shell, CORS shim, filesystem script storage |
| `packages/host-android` | WebView shell, APK asset serving at the game origin |
| `scripts` | Example bot scripts |

```bash
pnpm -r typecheck   # all packages
pnpm -r test        # 143 tests
```

### Building installers yourself

```bash
pnpm --filter @dfh/ui build              # the shared web bundle, needed by both hosts
pnpm --filter @dfh/host-electron build   # compile main process + copy the bundle in
pnpm --filter @dfh/host-electron package # electron-builder, current platform only
```

Artifacts land in `packages/host-electron/release/`. electron-builder only
targets the platform it runs on, which is why the release workflow fans out
across macOS, Windows and Linux runners.

For Android, see the Android quickstart above; CI builds the same
`gradle assembleDebug`.

App icons are generated from [`assets/icon.svg`](./assets/icon.svg).

---

## Credits

- [Ruffle](https://ruffle.rs) — the reason any of this is possible in 2026.
- [DF Pocket](https://github.com/anthony-hyo/df-mobile) — the Ruffle
  configuration and the base-URL approach that makes DragonFable run in a
  mobile WebView.
- [Skua](https://github.com/BrenoHenrike/Skua) — the scriptable-client model
  this follows.

MIT licensed. Not affiliated with Artix Entertainment.
