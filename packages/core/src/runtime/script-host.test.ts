import { describe, expect, it, vi } from 'vitest';
import { Bot } from '../api/bot.js';
import { MockBridge } from '../bridge/mock-bridge.js';
import { Logger } from './logger.js';
import { compileScript, MemoryScriptStorage, ScriptHost, type ScriptSource } from './script-host.js';

async function makeHost() {
  const bridge = new MockBridge({ seed: 11 });
  const log = new Logger('test', 'error');
  const bot = new Bot({ bridge, log, options: { actionDelayMs: 0, waitTimeoutMs: 2000, waveGapMs: 0 } });
  await bot.start();
  return { host: new ScriptHost(bot, log), bot, bridge };
}

const script = (code: string): ScriptSource => ({ id: 'test.js', name: 'test', code });

describe('compileScript', () => {
  it('compiles a bare statement body', async () => {
    const fn = compileScript(script('return bot.player.name;'));
    const { bot } = await makeHost();
    await expect(fn(bot)).resolves.toBe('MockHero');
  });

  it('compiles the export-default module form', async () => {
    const fn = compileScript(script('export default async function (bot) { return bot.player.level; }'));
    const { bot } = await makeHost();
    await expect(fn(bot)).resolves.toBe(10);
  });

  it('compiles an export-default arrow function', async () => {
    const fn = compileScript(script('export default async (bot) => bot.player.gold;'));
    const { bot } = await makeHost();
    await expect(fn(bot)).resolves.toBe(1000);
  });

  it('reports a syntax error with the script name', () => {
    expect(() => compileScript(script('this is not javascript {{{'))).toThrow(/Failed to compile script "test"/);
  });
});

describe('ScriptHost', () => {
  it('runs a script to completion', async () => {
    const { host } = await makeHost();
    await host.run(script('await bot.quests.runOnce(1, { waveGapMs: 0 });'));
    expect(host.status).toBe('completed');
  });

  it('surfaces a script error as a failed status', async () => {
    const { host } = await makeHost();
    const finished = vi.fn();
    host.events.on('finished', finished);

    await host.run(script('throw new Error("boom");'));

    expect(host.status).toBe('failed');
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(finished.mock.calls[0]?.[0].error?.message).toBe('boom');
  });

  it('refuses to start a second script while one is running', async () => {
    const { host } = await makeHost();
    const running = host.run(script('await bot.sleep(200);'));
    await expect(host.run(script('return 1;'))).rejects.toThrow(/already running/);
    await host.stop();
    await running;
  });

  it('stops a long-running grind promptly', async () => {
    const { host, bot } = await makeHost();
    const running = host.run(script('await bot.grind({ questId: 1, turnIn: false });'));

    // Let the grind get going, then pull the plug.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.isRunning).toBe(true);
    await host.stop();
    await running;

    expect(host.status).toBe('stopped');
    expect(bot.cancelled).toBe(false); // token is released after the run
  });

  it('reports a stopped script through the status stream', async () => {
    const { host } = await makeHost();
    const statuses: string[] = [];
    host.events.on('statusChanged', ({ status }) => statuses.push(status));

    const running = host.run(script('await bot.sleep(5000);'));
    await host.stop();
    await running;

    expect(statuses).toEqual(['running', 'stopping', 'stopped']);
  });

  it('lets a script cooperatively check for stop', async () => {
    const { host } = await makeHost();
    const running = host.run(
      script('for (;;) { bot.checkStop(); await bot.sleep(5); }'),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await host.stop();
    await running;
    expect(host.status).toBe('stopped');
  });
});

describe('MemoryScriptStorage', () => {
  it('stores, lists and removes scripts', async () => {
    const storage = new MemoryScriptStorage([script('return 1;')]);
    expect(await storage.list()).toHaveLength(1);

    await storage.write({ id: 'b.js', name: 'b', code: 'return 2;' });
    expect(await storage.list()).toHaveLength(2);
    expect((await storage.read('b.js')).code).toBe('return 2;');

    await storage.remove('b.js');
    expect(await storage.list()).toHaveLength(1);
    await expect(storage.read('b.js')).rejects.toThrow(/No script with id/);
  });
});
