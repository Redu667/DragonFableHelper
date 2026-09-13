/**
 * Farm a quest until you have the items you want.
 *
 * The most common thing you will ever want a DragonFable bot to do: repeat a
 * quest, fight every wave, and stop once the drops have added up.
 */
export default async function (bot) {
  bot.options.actionDelayMs = 700;   // be gentle with the client
  bot.options.restBelowHpPercent = 55;
  bot.options.stopOnDeath = true;

  const stats = await bot.grind({
    questId: 1,
    until: [{ item: 'Sneevil Box', quantity: 25 }],
    // Turning the quest in would consume the very items we are collecting.
    turnIn: false,
    rotation: '3:mobs>1 | 2 | 1',
  });

  bot.log.info(`Done in ${stats.runs} runs (${stats.deaths} deaths).`);
}
