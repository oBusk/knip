import { ISSUE_TYPES } from '../constants.js';
import type { Report } from '../types/issues.js';
import { ConfigurationError } from './errors.js';

type CLIArguments = {
  include: string[];
  exclude: string[];
  dependencies: boolean;
  exports: boolean;
  files: boolean;
};

type Options = {
  isProduction?: boolean;
  include?: string[];
  exclude?: string[];
  dependencies?: boolean;
  exports?: boolean;
};

/** @internal */
export const defaultExcludedIssueTypes = ['classMembers', 'nsExports', 'nsTypes'];
const defaultIssueTypes = ISSUE_TYPES.filter(type => !defaultExcludedIssueTypes.includes(type));

const normalize = (values: string[]) => values.flatMap(value => value.split(','));

export const getIncludedIssueTypes = (
  cliArgs: CLIArguments,
  { include = [], exclude = [], isProduction = false }: Options = {}
) => {
  // Allow space-separated argument values (--include files,dependencies)
  let incl = normalize(cliArgs.include);
  const excl = normalize(cliArgs.exclude);

  // Naming is hard...
  for (const type of [...incl, ...excl, ...include, ...exclude]) {
    // @ts-expect-error The point is that we're checking for invalid issue types
    if (!ISSUE_TYPES.includes(type)) throw new ConfigurationError(`Invalid issue type: ${type}`);
  }

  // CLI arguments override local options
  const excludes = exclude.filter(exclude => !incl.includes(exclude));
  const includes = include.filter(include => !excl.includes(include));

  if (cliArgs.dependencies) {
    incl = [...incl, 'dependencies', 'optionalPeerDependencies', 'unlisted', 'binaries', 'unresolved'];
  }
  if (cliArgs.exports) {
    incl = [...incl, 'exports', 'nsExports', 'classMembers', 'types', 'nsTypes', 'enumMembers', 'duplicates'];
  }
  if (cliArgs.files) {
    incl = [...incl, 'files'];
  }

  const _include = [...incl, ...includes];
  const _exclude = [...excl, ...excludes];

  if (isProduction) {
    // Ignore devDependencies when analyzing production code
    _exclude.push('devDependencies');
  } else {
    // Auto-add (or remove) `devDependencies` when `dependencies` are included (or excluded)
    if (_include.includes('dependencies')) _include.push('devDependencies', 'optionalPeerDependencies');
    if (_exclude.includes('dependencies')) _exclude.push('devDependencies', 'optionalPeerDependencies');
  }

  const included = (
    _include.length > 0
      ? _include.some(type => !defaultExcludedIssueTypes.includes(type))
        ? _include
        : [..._include, ...defaultIssueTypes]
      : defaultIssueTypes
  ).filter(group => !_exclude.includes(group));

  return ISSUE_TYPES.reduce((types, group) => {
    types[group] = included.includes(group);
    return types;
  }, {} as Report);
};
