import { createDashboard } from '../../dashboard/src/server.js';

export interface RunningDashboard { url: string; close(): Promise<void> }
/** Serves the shared web dashboard for one config on a random loopback port. The window shows this page; no UI is duplicated. */
export async function startDashboard(configPath: string, assets: string): Promise<RunningDashboard> {
  const dashboard = createDashboard(configPath, assets);
  await new Promise<void>((resolve, reject) => { dashboard.server.once('error', reject); dashboard.server.listen(0, '127.0.0.1', resolve); });
  const address = dashboard.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/`, close: () => dashboard.close() };
}
