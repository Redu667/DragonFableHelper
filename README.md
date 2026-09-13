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
                                                    │ ExternalInterface
                                                    │ + AVM1 variables
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

## Wiring the live bridge — read this before reporting a bug

The mock bridge is complete. **The Ruffle bridge is a working harness whose
symbol map still needs to be filled in against a real client**, and this is
deliberate rather than an oversight.

DragonFable's internals are not public, they change between releases, and I
could not inspect a live client while writing this — so rather than invent
ActionScript paths and present them as fact, `packages/bridge-ruffle/src/df-symbols.ts`
holds **clearly-labelled best guesses in one overridable map**, plus a probe
that tells you which ones are real:

```js
const probe = bridge.probe();
probe.resolved;       // paths that returned a value
probe.unresolved;     // paths that need overriding
probe.callbacksFound; // ExternalInterface callbacks the client actually exposes
```

Then override only what is wrong:

```js
new RuffleBridge({ player, symbols: { playerHp: '_root.game.hero.hp' } });
```

Calls with no client support yet (`shop.buy`, `quest.load`, …) throw a named
`BridgeError` instead of silently doing nothing, so you always know what is
missing. Nothing outside that one file knows about the game's internals — when
a path moves, one map changes and every script keeps working.

---

## Layout

| Package | Contents |
| --- | --- |
| `packages/core` | Bot engine, script API, rotations, grinder, state, mock game. Pure TS. |
| `packages/bridge-ruffle` | Ruffle host, DF symbol map + probe, state polling and event derivation |
| `packages/ui` | React panels, shared by both hosts |
| `packages/host-electron` | Desktop shell, CORS shim, filesystem script storage |
| `packages/host-android` | WebView shell, APK asset serving at the game origin |
| `scripts` | Example bot scripts |

```bash
pnpm -r typecheck   # all packages
pnpm -r test        # 89 tests
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
