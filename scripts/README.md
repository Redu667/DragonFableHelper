# Example scripts

Each file exports a default `async function (bot)`. Open the **Script** tab,
paste one in, and press Run — or drop the file in the app's scripts folder
(Electron: `<userData>/scripts`).

| Script | What it shows |
| --- | --- |
| `farm-quest-items.js` | The basic grind loop with a drop goal |
| `daily-quests.js` | Iterating quests, skipping completed ones, cooperative stopping |
| `careful-boss-fight.js` | Conditional rotations plus potion/flee safety rules |

Scripts run with the application's own permissions. Read anything you did not
write before you run it.
