/**
 * A single hard fight with real safety rules.
 *
 * Demonstrates the conditional rotation: a heal when low, a cooldown opener
 * once per battle, an AoE only when it is worth it, and a potion/flee net
 * underneath all of it.
 */
export default async function (bot) {
  bot.options.usePotionBelowHpPercent = 45;
  bot.options.potionItemId = 3;      // your health potion's item id
  bot.options.fleeBelowHpPercent = 15;
  bot.options.actionDelayMs = 900;

  bot.combat.setRotation([
    { slot: 4, playerHpBelow: 50, label: 'heal' },
    { slot: 5, maxUsesPerBattle: 1, label: 'dragon opener' },
    { slot: 3, minMonstersAlive: 2, label: 'aoe' },
    { slot: 2, everyRounds: 2, label: 'heavy hit' },
    { slot: 1, label: 'attack' },
  ]);

  await bot.player.rest();
  const result = await bot.quests.runOnce(3);

  bot.log.info(result.turnedIn ? 'Boss cleared and turned in.' : 'Boss not cleared.');
}
