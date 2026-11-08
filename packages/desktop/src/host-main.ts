import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { startDashboard } from './dashboard.js';
import { createHost } from './host.js';
import { openDirectory } from './open.js';
import { WorkspaceStore } from './workspace.js';

/** The line protocol spoken with the Tauri shell: one JSON object per line in, one per line out. */
export interface Wiring { input: NodeJS.ReadableStream; write(line: string): void; args: string[] }

function value(args: string[], name: string): string {
  const index = args.indexOf(name);
  const found = index < 0 ? undefined : args[index + 1];
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
const option = (args: string[], name: string) => resolve(value(args, name));

/** Runs until the input closes. Responses carry the request id; events carry an `event` name. */
export async function runHost(wiring: Wiring): Promise<void> {
  const cliPath = option(wiring.args, '--cli');
  const host = createHost({
    store: new WorkspaceStore(join(option(wiring.args, '--data-dir'), 'workspaces.json')),
    cli: { command: process.execPath, args: [cliPath] },
    assets: option(wiring.args, '--assets'),
    emit: event => wiring.write(JSON.stringify(event)),
    startDashboard, openFolder: openDirectory, ...(wiring.args.includes('--poll-ms') ? { pollMs: Number(value(wiring.args, '--poll-ms')) } : {}),
  });
  const pending = new Set<Promise<void>>();
  const serve = async (line: string) => {
    let id: unknown;
    try {
      const request = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown };
      id = request.id;
      wiring.write(JSON.stringify({ id, ok: true, result: await host.handle(request.method, request.params) }));
    } catch (error) {
      wiring.write(JSON.stringify({ id: id ?? null, ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  };
  for await (const line of createInterface({ input: wiring.input })) {
    const task = serve(line); pending.add(task); void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
  await host.stop();
}
