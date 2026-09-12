/**
 * Run a list of dailies once each, resting in between.
 *
 * Shows per-quest results and how to skip work that is already done.
 */
const DAILIES = [
  { id: 3, name: 'Bandit Camp' },
  // Add your own: { id: 1234, name: 'Whatever' },
];

export default async function (bot) {
  bot.options.restBelowHpPercent = 70;

  for (const daily of DAILIES) {
    bot.checkStop(); // lets the Stop button interrupt between quests

    if (bot.quests.isCompleted(daily.id)) {
      bot.log.info(`${daily.name} is already done today - skipping.`);
      continue;
    }

    await bot.player.restIfNeeded();
    const result = await bot.quests.runOnce(daily.id, { rotation: '2 | 1' });

    if (result.died) {
      bot.log.error(`Died on ${daily.name}; stopping so you can re-gear.`);
      break;
    }
    bot.log.info(`${daily.name}: ${result.battlesWon} battles won, turned in: ${result.turnedIn}`);
  }
}
