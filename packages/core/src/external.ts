import { readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { message, packageName, pluginPackageSchema } from '../../protocol/src/index.js';
import type { EcosystemPlugin, GatePlugin, ParserPlugin } from '../../plugin-sdk/src/index.js';
/** Third-party plugins grouped by what they extend. */
export interface LoadedPlugins { parsers: Record<string, ParserPlugin>; ecosystems: EcosystemPlugin[]; gates: Record<string, GatePlugin> }
type Exports = string | { import?: Exports; default?: Exports } | undefined;
const entryOf = (exports: Exports): string | undefined =>
  typeof exports === 'string' ? exports : exports ? entryOf(exports.import ?? exports.default) : undefined;
/** Resolves the entry file from `exports["."]`, `main` or `index.js`; it must stay inside the package folder. */
async function resolveEntry(name: string, root: string): Promise<string> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { exports?: Record<string, Exports> | string; main?: string };
  const exported = typeof pkg.exports === 'object' && pkg.exports && '.' in pkg.exports ? pkg.exports['.'] : pkg.exports as Exports;
  const entry = await realpath(join(root, entryOf(exported) ?? pkg.main ?? 'index.js'));
  const inside = relative(root, entry);
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`Plugin ${name}: entry outside the package folder`);
  return entry;
}
type Candidate = ParserPlugin | EcosystemPlugin | GatePlugin;
/** Imports one package and returns its validated plugins. */
async function importPackage(directory: string, name: string): Promise<Candidate[]> {
  let pkg: unknown;
  try {
    const modules = await realpath(join(directory, 'node_modules')).catch(() => join(directory, 'node_modules'));
    const root = await realpath(join(directory, 'node_modules', name)).catch(() => {
      throw new Error(`Plugin package not found: ${name} (install it in the project's node_modules)`);
    });
    const inside = relative(modules, root);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`Plugin ${name}: package resolves outside node_modules`);
    const module = await import(pathToFileURL(await resolveEntry(name, root)).href) as { manifest?: unknown; default?: unknown };
    pkg = module.manifest ?? module.default;
  } catch (error) {
    const text = message(error);
    throw new Error(/^Plugin /.test(text) ? text : `Cannot load plugin ${name}: ${text}`);
  }
  if (!pkg) throw new Error(`Plugin ${name} exports no manifest`);
  const parsed = pluginPackageSchema.safeParse(pkg);
  if (!parsed.success) throw new Error(`Invalid plugin package ${name}: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return (pkg as { plugins: Candidate[] }).plugins;
}
/**
 * Imports the listed packages from `<directory>/node_modules` (the explicit opt-in), validates their manifest and
 * rejects ids that clash with `reserved` (built-ins) or with each other. The code runs unsandboxed.
 */
export async function loadExternalPlugins(directory: string, packages: string[], reserved: Iterable<string> = []): Promise<LoadedPlugins> {
  const loaded: LoadedPlugins = { parsers: {}, ecosystems: [], gates: {} };
  const ids = new Set(reserved);
  for (const name of packages) {
    if (!packageName.safeParse(name).success) throw new Error(`Invalid plugin package name: ${name}`);
    for (const plugin of await importPackage(directory, name)) {
      if (ids.has(plugin.id)) throw new Error(`Duplicate plugin id: ${plugin.id} (${name})`);
      ids.add(plugin.id);
      if (plugin.kind === 'parser') loaded.parsers[plugin.id] = plugin;
      else if (plugin.kind === 'ecosystem') loaded.ecosystems.push(plugin);
      else loaded.gates[plugin.id] = plugin;
    }
  }
  return loaded;
}
