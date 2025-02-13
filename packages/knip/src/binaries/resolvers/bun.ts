import parseArgs from 'minimist';
import type { Resolver } from '../types.js';
import { tryResolveFilePath } from '../util.js';

const commands = ['add', 'create', 'init', 'install', 'link', 'pm', 'remove', 'run', 'test', 'update'];

export const resolve: Resolver = (_binary, args, { manifestScriptNames, cwd, fromArgs }) => {
  const parsed = parseArgs(args);
  const [command, script] = parsed._;
  if (command === 'run' && manifestScriptNames.has(script)) return [];
  if (commands.includes(command)) return [];
  const filePath = command === 'run' ? script : command;
  const specifier = tryResolveFilePath(cwd, filePath);
  if (specifier) return [specifier];
  return fromArgs(args);
};
