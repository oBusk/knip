export interface CommandLineOptions {
  cwd: string;
  tsConfigFile?: string;
  gitignore: boolean;
  isDebug: boolean;
  isStrict: boolean;
  isProduction: boolean;
  isShowProgress: boolean;
  isIncludeEntryExports: boolean;
  isIncludeLibs: boolean;
  isIsolateWorkspaces: boolean;
  isWatch: boolean;
  isCache?: boolean;
  cacheLocation?: string;
  tags: Tags;
  isFix: boolean;
  fixTypes: string[];
}

export type Tags = [string[], string[]];
