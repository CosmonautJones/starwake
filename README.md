# Starwake

Space racing and dogfighting in the browser. Build a craft in the hangar, then race it down glowing wormholes or take it into an open arena battle, against AI pilots or other players.

Built with plain ES modules and [Three.js](https://threejs.org) (vendored, no build step).

## Run it

```bash
npm install     # installs `ws` (relay server) and three (already vendored in /vendor)
npm start       # serves the game and the multiplayer relay
```

Open the address it prints (default http://localhost:8080). `PORT=9000 npm start` changes the port.

Any static file server also works (`npx serve .`, `python3 -m http.server`). Single-player and same-browser multiplayer run fine that way; only relay multiplayer needs `npm start`. Opening `index.html` straight from disk (`file://`) won't work, because browsers block ES modules there.

You need a browser with WebGL 2: current Chrome, Edge, Firefox or Safari with hardware acceleration on.

## Playing

Starwake has two modes:

- **Wormhole race** (the main game): fly a glowing tunnel that snakes through space, and cross the line first. The tunnel wall keeps you on course — scraping it costs a little speed but never stops you — so there's no getting lost. Amber **boost gates** float inside the tube, off-centre; flying through them refills boost (consecutive gates refill more), and missing one costs nothing. Asteroids, cargo pods, mines and pillars sit inside the tunnel to dodge or blast.
- **Battle**: a free-roam deathmatch in an open arena around a station, wrecks and rock fields, either free-for-all or Blue versus Red teams (no friendly fire). First to the kill target wins, or whoever has the most kills when time runs out. A soft field pushes you back if you stray outside the arena.

Both modes can carry **hazards** (Off, Light, Normal or Heavy): drifting plasmoids that burn anyone who touches them, and the Vesk, an alien drone faction that ambushes everyone and drops pickups when shot down.

### Racing feel

Ships handle like Rocket League cars in a pod-race tunnel:

- **Boost pads**: small amber diamonds near the middle of the tube give a sip of boost; three big glowing orbs per lap sit out near the wall and fill the tank. The risky line pays. Pads come back after a few seconds, and every racer has their own, so nobody can deny them.
- **Supersonic**: hold boost at full speed and the ship goes supersonic, with a sonic trail, streaks and a louder engine.
- **Demolitions**: hit a rival head-on while supersonic and they're wrecked and respawn a little behind. Slower hits are **bumps** that shove both ships apart.
- **Dodge**: a quick sideways barrel roll that also knocks away incoming lasers, with a short cooldown.
- **Near misses** with rocks and rivals top up your boost.
- Setbacks stay short: stuns are capped and you can't be stun-locked, and respawns never put you ahead of where you were.

| Action | Keyboard + mouse | Controller |
| --- | --- | --- |
| Steer | Move the mouse (or arrow keys) | Left stick |
| Thrust | W | RT |
| Brake / reverse | S | LT |
| Roll | A D (or Q E) | Right stick |
| Fire lasers | Left click (or F) | RB |
| Fire missile | Right click (or G) | LB |
| Boost | Space or Shift | A |
| Dodge | Double-tap A/D (or Q/E), or X | B |
| Back on track (race) | R | Y |
| Switch camera | C | Back |
| Pause | Esc or P | Start |

- **Mouse flight**: the ship turns toward the reticle, and the further it is from the centre, the harder you turn. The small circle shows where your nose points. The first click in a match captures the mouse (Esc releases it); you can turn that off in Settings, along with sensitivity and invert.
- **Track assist** (races): when the reticle is near the centre, the ship eases its nose down the tunnel and levels its wings by itself, and if you end up facing backwards it turns you round. Steer and you're in full control again. Pick Off, Light, Normal or Strong in Race setup. If you're facing the wrong way for a few seconds anyway, you're put back on the line facing forwards.
- **Assists**, set in Settings, each Off to Strong:
  - **Aim assist** snaps lasers onto rivals near the reticle, locks missiles on automatically when a rival is in range, and shows a lead marker where to shoot.
  - **Flight assist** steers you round rocks and mines, keeps your wings level, and eases you onto your target in a dogfight.
  - **Track assist** (races) follows the tunnel when the mouse is centred.
- **Lasers** alternate barrels and fire where the reticle points. They build heat, and overheating locks them out briefly.
- **Missiles**: when the lock ring closes on a rival, right-click. Locked missiles home in, but they're slow enough to outturn or dodge, and they lose the lock if the target gets outside their seeker. Without a lock they fly straight. You start with three and carry up to four.
- **Shields and hull**: shields absorb damage and recharge after a few seconds. When hull reaches zero your ship explodes. In a race you respawn on the line a little behind where you were; in a battle you respawn at the arena spawn point farthest from your rivals, briefly invulnerable.
- **Breakables**: asteroids, ice, crystals, cargo pods and satellites can be shot (or rammed) apart. They drop boost, missiles or shield repairs. Mines explode when hit or touched. Broken objects return after about 30 seconds.

### Courses and arenas

| Wormhole | Difficulty | Character |
| --- | --- | --- |
| Corona Run | Easy | A wide tube of long arcs past a ringed gas giant, narrowing through an orbital station |
| Shatterfield | Medium | Asteroids drifting through the tunnel around a broken freighter |
| Ice Veil | Hard | A narrow tube of tight vertical turns, ice shards and a minefield |

| Arena | Character |
| --- | --- |
| Drift Yard | A salvage yard round a derelict station: long sightlines, rock clusters for cover |
| Glacier Halo | Frozen shards and a minefield near an ice moon: tight and full of ambushes |

### Hangar

Pick a body (Dart, Arrow, Hauler, Glider, Hoverbike), then wings, engines, fins and cockpit, and paint the hull, trim and glow. Each part shifts six ratings: top speed, acceleration, handling (turn rate), grip (how quickly your velocity follows the nose), boost and armor. Mass is the trade-off: heavy craft turn and accelerate slower but carry more hull and shrug off collisions. The stat panel shows changes against the design you started from.

The five presets are read-only. Editing one saves your changes as a new craft. Your designs, settings and personal bests are saved in the browser's localStorage.

## Multiplayer

Choose **Multiplayer**, then host or join with a 4-letter room code. The host picks the mode (wormhole race or battle), the course or arena, laps or kill target and time limit, and how many AI pilots or bots join. Players ready up, and the host starts the match. Everyone sees each other's names and craft in the lobby and in the match. Results are agreed by the host, and the host can take everyone back to the lobby for another round.

There are two connection modes, and both really connect players:

1. **This browser**: a `BroadcastChannel` links Starwake tabs and windows open in the same browser on one computer. It needs no server, so it's handy for testing and side-by-side play.
2. **Relay server**: `npm start` also runs a small WebSocket relay at `/relay`. Players on other computers open the server's address (the startup log prints your LAN address) and join with the room code. To play over the internet, host `server/server.mjs` anywhere that runs Node (or put it behind a tunnel) and share the URL.

How it works: each player simulates their own ship and sends compact state snapshots 20 times a second. Remote ships are drawn 110 ms in the past with interpolation. Shots, missiles, broken objects and pickups travel as small game events. Whoever fires decides whether a shot hit, and the victim's game applies the damage. The host simulates the AI pilots and owns the lobby, the end of a battle and the final results. Every client builds the same course or arena layout from its id, so object ids match everywhere. Countdowns are pinned to a shared start moment, so everyone gets GO together.

Limits, stated plainly: there is no anti-cheat, because clients are trusted to report their own position and hits. There's no matchmaking or lobby browser, only room codes. The relay doesn't persist anything.

### Adding another backend

Networking is isolated in `js/net/`:

- `transport.js`: a `Transport` base class (`open(room)`, `send(msg, to?)`, `close()`, events `message` / `peer-joined` / `peer-left` / `closed`) plus the `BroadcastTransport` and `WsTransport` implementations.
- `session.js`: `NetSession`, the lobby and race protocol. It runs on top of any `Transport`.

To use WebRTC, a hosted service (Ably, Pusher, PartyKit, etc.) or your own server, write a new `Transport` subclass and choose it in `NetSession`'s constructor. The game code only talks to `NetSession`.

## Project layout

```
index.html            page shell + import map
css/style.css         all interface styling
js/main.js            app shell: renderer, bloom, stage switching, game loop
js/core/              util, storage, input (mouse, keyboard, gamepad), synthesized audio
js/craft/             part catalog + stat model, procedural craft meshes
js/flight/            courses + arenas, ship physics, world (breakables, pickups, collisions), weapons,
                      player assists, boost pads, hazards (plasmoids, Vesk), race AI + battle AI,
                      match controller
js/space/             sky + planets, wormhole tunnel, procedural asteroids, props (stations, wrecks…),
                      effects, debris, speed effects, hazard visuals
js/world/             engine trails/sparks, hangar stage
js/ui/                screens (menus, lobby, results), hangar editor, HUD
js/net/               transports + multiplayer session
server/server.mjs     static file server + WebSocket relay
tools/                headless checks (see below)
vendor/three/         Three.js r187 (MIT) + bloom post-processing addons
```

### Design notes

- **Arcade flight model.** The cursor commands pitch and yaw rates, and roll is manual. "Flight assist" swings the velocity vector onto the nose at a rate set by the craft's grip, and turns most sideways speed back into forward speed (never more than you had), so light craft carve and heavy ones slide. Throttle sets a target speed. Physics run at a fixed 120 Hz.
- **The wormhole** is a tube round the course spline whose radius varies along the lap (pinches narrow it through stations and tight bends). Each physics step finds the ship's place on the line by hill-climbing from the last one, pushes it back inside the wall, and counts progress as distance along the line, so laps, positions and gates need no checkpoints.
- **One seeded world.** Every rock, pod and mine is placed from the course or arena id with a seeded RNG and indexed in a spatial grid used for collisions, laser raycasts and AI look-ahead.
- **Race AI** flies with the same inputs a player has: it pursues a drifting lane down the tunnel, lines up for boost gates, plans speed from the curvature ahead, steers its velocity rather than its nose, dodges or shoots obstacles, and fights rivals in front of it. **Battle AI** picks and sticks to targets, chases for a firing solution, jinks away from incoming missiles, grabs pickups when hurt or out of missiles, and stays inside the arena.
- **Hazards** are deterministic where they can be: plasmoids follow seeded paths, so every client draws the same ones without sync. Vesk drones are simulated by one client (solo, or the multiplayer host) and sent to the others 10 times a second.
- **Demolitions are decided by the victim's game**, like laser hits: the rammer must be supersonic, closing fast and heading into the victim.
- **Destruction**: wrecked ships and broken rocks split into real tumbling chunks of their own mesh, which bounce off the tunnel wall and fade.
- **Everything is generated in code**: sky, planets, asteroids, props, craft and audio. The game ships no textures, models or sound files.

## Checks and debugging

```bash
npm run check                        # wormhole geometry: bends vs tube radius, overlaps, gates inside
node tools/flight-sim.mjs normal 2   # headless race with weapons: every preset, every course, AI must finish
node tools/assist-sim.mjs            # hands-off, flailing and backwards pilots must still finish a lap
node tools/battle-sim.mjs normal 180 # headless battle: bots in every arena, kills/deaths/crash stats
node tools/player-sim.mjs            # rough-human pilots with and without assists: hit rate, kills, finishes
node tools/hazard-sim.mjs            # hazards: drones fight, plasmoids are identical on every client
node tools/test-net.mjs              # multiplayer: both transports, relay server, error paths
npm test                             # the course check, race, assist, battle and network tests together
```

Visual galleries open in the browser while the game is served: `tools/craft-gallery.html`, `tunnel-gallery.html`, `hazard-gallery.html` and `fx-gallery.html`.

URL parameters for testing:

- `?quick=race&track=shatter` skips the menus and starts a solo race (`corona`, `shatter`, `veil`).
- `?quick=battle&arena=glacier` starts a solo battle (`driftyard`, `glacier`).
- `?autopilot=1` hands your craft to an AI pilot.
- `?timescale=4` fast-forwards the simulation.

Settings → **Show frame rate** displays the frame rate. If a machine struggles, set **Quality** to Low (it turns off bloom, lowers resolution and reduces particles).

## Credits

Three.js © three.js authors, MIT licence (`vendor/three/LICENSE`). Fonts: Unbounded and Saira via Google Fonts. If those can't load, the game falls back to system fonts.
