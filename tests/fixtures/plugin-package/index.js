import { access } from 'node:fs/promises';
import { join } from 'node:path';
/** Test fixture: one parser, one ecosystem and one gate, as a third-party package would export them. */
export const manifest = {
  apiVersion: 1,
  plugins: [
    {
      apiVersion: 1, kind: 'parser', id: 'fixture-json',
      parse: (raw, { gateId }) => JSON.parse(raw).map(item => ({ gateId, severity: 'error', message: item.message, file: item.file, line: item.line })),
    },
    {
      apiVersion: 1, kind: 'ecosystem', id: 'fixture-eco',
      detect: async directory => (await access(join(directory, 'fixture.marker')).then(() => true, () => false)) ? [{ id: 'fixture-check', run: 'true' }] : null,
    },
    {
      apiVersion: 1, kind: 'gate', id: 'fixture-gate',
      run: async spec => ({ exitCode: 0, output: `fixture gate ran: ${spec.run}` }),
    },
  ],
};
