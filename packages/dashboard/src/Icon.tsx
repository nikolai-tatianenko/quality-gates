const paths = {
  overview: 'M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z',
  checks: 'm3 6 2 2 4-4m3 2h9M3 14l2 2 4-4m3 2h9M3 21h18',
  findings: 'M9 3h6l6 6v6l-6 6H9l-6-6V9l6-6Zm3 4v6m0 4h.01',
  terminal: 'm4 7 5 5-5 5m9 0h7',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-5v5l3 2',
  shield: 'm12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Zm-4 9 3 3 5-6',
  team: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m10-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm10 10v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  play: 'm8 5 11 7-11 7V5Z',
};
export type IconName = keyof typeof paths;
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <svg className={`ui-icon ${className}`} viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]}/></svg>;
}
