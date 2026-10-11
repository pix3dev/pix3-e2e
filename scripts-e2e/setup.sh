#!/usr/bin/env bash
# Recreate the scripts-e2e project (pix3-core `.plans/scripts-vite.md`): an empty 2D project made by
# `pix3 new 2d` from a pix3-core checkout (default ../../pix3-core; pass another as $1),
# plus one script component whose schema comes from a nested module outside scripts/, and one bot
# policy with a helper outside design/tests/bots/. node_modules is a symlink into the checkout, so
# the plugin and the editor come from its packages' dist/ — build them first:
#   (cd <core> && npm run build -w packages/editor-core && npm run build -w packages/vite-plugin)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CORE="$(cd "${1:-$HERE/../../pix3-core}" && pwd)"
PROJ="$HERE/proj"
rm -rf "$PROJ"
(cd "$HERE" && node "$CORE/packages/cli/src/index.ts" new 2d proj --name scripts-e2e >/dev/null)
ln -s "$CORE/node_modules" "$PROJ/node_modules"
cat > "$PROJ/vite.config.ts" <<'TS'
import { defineConfig } from 'vite';
import { pix3 } from '@pix3/vite-plugin';

export default defineConfig({
  plugins: [pix3()],
  server: { host: '127.0.0.1' },
  cacheDir: '.vite-cache',
});
TS

mkdir -p "$PROJ/scripts" "$PROJ/src/game" "$PROJ/design/tests/bots" "$PROJ/design/tests/lib"
cat > "$PROJ/scripts/Mover.ts" <<'TS'
import { Script, type PropertySchema } from '@pix3/runtime';

import { FIELDS } from '../src/game/fields.ts';

/** The inspector shows one number field per entry of FIELDS (a module the script imports). */
export class Mover extends Script {
  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'Mover',
      properties: FIELDS.map(field => ({
        name: field.name,
        type: 'number' as const,
        ui: { label: field.label, group: 'Mover' },
        getValue: (s: unknown) => (s as Mover).config[field.name] ?? 0,
        setValue: (s: unknown, v: unknown) => {
          (s as Mover).config[field.name] = Number(v);
        },
      })),
      groups: { Mover: { label: 'Mover', expanded: true } },
    };
  }
}
TS
cat > "$PROJ/src/game/fields.ts" <<'TS'
export const FIELDS = [{ name: 'speed', label: 'Speed' }];
TS
cat > "$PROJ/design/tests/lib/mark.ts" <<'TS'
export const MARK = 'mark-v1';
TS
cat > "$PROJ/design/tests/bots/idle.ts" <<'TS'
import { MARK } from '../lib/mark.ts';

// Typed by the kit's design/tests/bots/pix3-test-bot.d.ts (global BotPolicy / Pix3TestBot).
export default {
  name: 'idle',
  tick(bot) {
    if (bot.frame === 1) bot.log(`idle ${MARK}`);
    if (bot.frame >= 3) bot.done(true, `idle ${MARK}`);
  },
} satisfies BotPolicy;
TS

# The background node carries the component; a Title label sits next to it.
python3 - "$PROJ/scenes/main.pix3scene" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
anchor = "            bottom: 0\n        children: []\n"
assert anchor in text, 'starter scene changed: update setup.sh'
text = text.replace(anchor, "            bottom: 0\n        components:\n          - id: mover\n            type: user:Mover\n            enabled: true\n            config:\n              speed: 3\n        children: []\n")
# A label the inspector edits (pix3_scene must answer what the inspector and the file have).
text = text.rstrip('\n') + "\n      - id: title\n        type: Label2D\n        name: Title\n        properties:\n          label: Play\n          width: 400\n          height: 80\n"
open(path, 'w').write(text)
PY
# Autoloads (pix3-core S10): a Counter singleton declared in pix3project.yaml, and a scene pair the
# Hop script walks with changeScene — the counter must tick through it as one instance.
cat > "$PROJ/scripts/Counter.ts" <<'TS'
import { registerGameDebug, Script, type PropertySchema } from '@pix3/runtime';
import { Hop } from './Hop';

/** Autoload: one per play session, kept across changeScene. */
export class Counter extends Script {
  ticks = 0;
  /** Spec §6.19.2: the running scene's group `hops`, read every tick; callGroup once, at tick 3. */
  hops: string[] = [];
  called = -1;
  readonly id = Math.random().toString(36).slice(2);
  readonly scenes: string[] = [];
  static getPropertySchema(): PropertySchema {
    return { nodeType: 'Counter', properties: [] };
  }
  onStart(): void {
    registerGameDebug({
      name: 'counter',
      snapshot: () => ({ ticks: this.ticks, id: this.id, scenes: [...this.scenes], scene: this.scenes.at(-1) ?? null, hops: [...this.hops], called: this.called, pinged: Hop.pinged }),
    });
  }
  onUpdate(): void {
    this.ticks += 1;
    const scene = this.scene?.getRootNodes()[0]?.name ?? null;
    if (scene && this.scenes.at(-1) !== scene) this.scenes.push(scene);
    this.hops = (this.scene?.getNodesInGroup('hops') ?? []).map(node => node.nodeId);
    if (this.ticks === 3) this.called = this.scene?.callGroup('hops', 'ping', 7) ?? -2;
  }
}
TS
cat > "$PROJ/scripts/Hop.ts" <<'TS'
import { Script, type PropertySchema } from '@pix3/runtime';

/** On the hop scene's root: after ten frames, change to the second scene. */
export class Hop extends Script {
  static pinged = 0;
  private frames = 0;
  ping(times: number): void {
    Hop.pinged += times;
  }
  static getPropertySchema(): PropertySchema {
    return { nodeType: 'Hop', properties: [] };
  }
  onUpdate(): void {
    this.frames += 1;
    if (this.frames === 10) void this.scene?.changeScene('res://scenes/hop-second.pix3scene', { transition: 'none' });
  }
}
TS
cat > "$PROJ/scenes/hop.pix3scene" <<'YAML'
version: 1.0.0
root:
  - id: hop-root
    type: Group2D
    name: Hop Root
    groups: [hops]
    components:
      - id: hop
        type: user:Hop
        enabled: true
        config: {}
YAML
cat > "$PROJ/scenes/hop-second.pix3scene" <<'YAML'
version: 1.0.0
root:
  - id: second-root
    type: Group2D
    name: Second Root
    groups: [hops]
    children:
      - id: second-child
        type: Group2D
        name: Second Child
        groups: [hops, other]
YAML
python3 - "$PROJ/pix3project.yaml" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
assert 'autoloads: []' in text, 'starter manifest changed: update setup.sh'
text = text.replace('autoloads: []', 'autoloads:\n  - singleton: Counter\n    scriptPath: scripts/Counter.ts')
open(path, 'w').write(text)
PY
echo "scripts-e2e project in $PROJ (core: $CORE)"
