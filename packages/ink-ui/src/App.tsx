import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { FIX_WARNING, FOOTER, detailLines, headerView, rowView, trendLines, type RowView } from './model.js';
import type { Session } from './session.js';

const TONE: Record<RowView['tone'], string | undefined> = { ok: 'green', bad: 'red', busy: 'cyan', warn: 'yellow', dim: undefined };

/** The screen: header, gate table, the open panel, the fix question, the last notice and the key help. All behaviour lives in `Session`. */
export function App({ session }: { session: Session }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  useEffect(() => { void session.finished.then(() => exit()); }, [session, exit]);
  useInput((input, key) => session.key({ input, up: key.upArrow, down: key.downArrow, enter: key.return, escape: key.escape, ctrlC: key.ctrl && input === 'c' }));
  // The clock tick above re-renders every 250 ms, so a resized terminal is picked up without a resize listener.
  const width = Math.max(20, (stdout.columns || 80) - 2);
  const header = headerView(state, session.root);
  const selected = state.selected === undefined ? undefined : state.rows[state.selected];
  return (
    <Box flexDirection="column">
      <Text bold>{header.title}</Text>
      <Text color={TONE[header.tone]}>{header.overall}</Text>
      <Box flexDirection="column" marginTop={1}>
        {state.rows.map((row, index) => {
          const view = rowView(row, now, width - 2);
          return <Text key={row.id} color={TONE[view.tone]} inverse={index === state.selected}>{index === state.selected ? '> ' : '  '}{view.text}</Text>;
        })}
      </Box>
      {state.panel === 'details' && <Box flexDirection="column" marginTop={1}>{detailLines(selected, width).map((line, index) => <Text key={index}>{line}</Text>)}</Box>}
      {state.panel === 'trends' && <Box flexDirection="column" marginTop={1}>{trendLines(state.trends, width).map((line, index) => <Text key={index}>{line}</Text>)}</Box>}
      {state.fix?.diffStat && <Box flexDirection="column" marginTop={1}>{state.fix.diffStat.split('\n').slice(-10).map((line, index) => <Text key={index} dimColor>{line}</Text>)}</Box>}
      {state.confirm && <Text color="yellow" bold>{FIX_WARNING} ({state.confirm.join(', ')})</Text>}
      {state.notice !== '' && <Text>{state.notice}</Text>}
      <Text dimColor>{FOOTER}</Text>
    </Box>
  );
}
