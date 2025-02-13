import type { SerializableImports } from '../types/map.js';

export const getHasStrictlyNsReferences = (importsForExport?: SerializableImports): [boolean, string?] => {
  if (!importsForExport?.hasStar || importsForExport.importedNs.size === 0) return [false];
  let namespace: string | undefined;
  for (const ns of importsForExport.importedNs) {
    const hasNs = importsForExport.identifiers.has(ns);
    if (!hasNs) return [false, ns];
    for (const id of importsForExport.identifiers) if (id.startsWith(`${ns}.`)) return [false, ns];
    namespace = ns;
  }
  return [true, namespace];
};

export const getType = (hasOnlyNsReference: boolean, isType: boolean) =>
  hasOnlyNsReference ? (isType ? 'nsTypes' : 'nsExports') : isType ? 'types' : 'exports';
