import type { Tags } from '../types/cli.js';

export const splitTags = (tags: string[]) =>
  tags
    .flatMap(tag => tag.split(','))
    .reduce<Tags>(
      ([incl, excl], tag) => {
        const match = tag.match(/[a-zA-Z]+/);
        if (match) (tag.startsWith('-') ? excl : incl).push(match[0]);
        return [incl, excl];
      },
      [[], []]
    );

const hasTag = (tags: string[], jsDocTags: Set<string>) => tags.some(tag => jsDocTags.has(`@${tag}`));

export const shouldIgnore = (jsDocTags: Set<string>, tags: Tags) => {
  // TODO This should not be necessary (related to de/serialization):
  if (Array.isArray(jsDocTags)) jsDocTags = new Set(jsDocTags);
  const [includeJSDocTags, excludeJSDocTags] = tags;
  if (includeJSDocTags.length > 0 && !hasTag(includeJSDocTags, jsDocTags)) return true;
  if (excludeJSDocTags.length > 0 && hasTag(excludeJSDocTags, jsDocTags)) return true;
  return false;
};
