import ts from 'typescript';
import { CacheConsultant } from './CacheConsultant.js';
import type { PrincipalOptions } from './PrincipalFactory.js';
import type { ReferencedDependencies } from './WorkspaceWorker.js';
import { getCompilerExtensions } from './compilers/index.js';
import type { AsyncCompilers, SyncCompilers } from './compilers/types.js';
import { DEFAULT_EXTENSIONS, FOREIGN_FILE_EXTENSIONS } from './constants.js';
import type {
  SerializableExport,
  SerializableExportMember,
  SerializableFile,
  SerializableMap,
  UnresolvedImport,
} from './types/map.js';
import type { BoundSourceFile, GetResolvedModule, ProgramMaybe53 } from './typescript/SourceFile.js';
import type { SourceFileManager } from './typescript/SourceFileManager.js';
import { createHosts } from './typescript/createHosts.js';
import { type GetImportsAndExportsOptions, _getImportsAndExports } from './typescript/getImportsAndExports.js';
import type { createCustomModuleResolver } from './typescript/resolveModuleNames.js';
import { timerify } from './util/Performance.js';
import { compact } from './util/array.js';
import { isStartsLikePackageName, sanitizeSpecifier } from './util/modules.js';
import { dirname, extname, isInNodeModules, join } from './util/path.js';
import { deserialize, serialize } from './util/serialize.js';

// These compiler options override local options
const baseCompilerOptions = {
  allowJs: true,
  allowSyntheticDefaultImports: true,
  declaration: false,
  declarationMap: false,
  esModuleInterop: true,
  inlineSourceMap: false,
  inlineSources: false,
  jsx: ts.JsxEmit.Preserve,
  jsxImportSource: undefined,
  lib: [],
  types: ['node'],
  noEmit: true,
  skipDefaultLibCheck: true,
  skipLibCheck: true,
  sourceMap: false,
};

const tsCreateProgram = timerify(ts.createProgram);

/**
 * This class aims to abstract away TypeScript specific things from the main flow.
 *
 * - Provided by the principal factory
 * - Collects entry and project paths
 * - Installs TS backend: file manager, language and compiler hosts for the TS program
 * - Creates TS program and typechecker
 * - Run async compilers ahead of time since the TS machinery is fully sync
 * - Bridge between main flow and TS AST walker
 */
export class ProjectPrincipal {
  // Configured by user and returned from plugins
  entryPaths = new Set<string>();
  projectPaths = new Set<string>();
  referencedDependencies: Set<[string, string, string]> = new Set();

  // We don't want to report unused exports of config/plugin entry files
  skipExportsAnalysis = new Set<string>();

  isGitIgnored: (path: string) => boolean;
  cwd: string;
  compilerOptions: ts.CompilerOptions;
  extensions: Set<string>;
  syncCompilers: SyncCompilers;
  asyncCompilers: AsyncCompilers;
  isSkipLibs: boolean;
  isWatch: boolean;

  cache: CacheConsultant<SerializableFile>;

  // @ts-expect-error Don't want to ignore this, but we're not touching this until after init()
  backend: {
    fileManager: SourceFileManager;
    compilerHost: ts.CompilerHost;
    resolveModuleNames: ReturnType<typeof createCustomModuleResolver>;
    program?: ProgramMaybe53;
    typeChecker?: ts.TypeChecker;
    languageServiceHost: ts.LanguageServiceHost;
  };

  findReferences?: ts.LanguageService['findReferences'];

  constructor({ compilerOptions, cwd, compilers, isGitIgnored, isSkipLibs, isWatch }: PrincipalOptions, n: number) {
    this.cwd = cwd;

    this.isGitIgnored = isGitIgnored;

    this.compilerOptions = {
      ...compilerOptions,
      ...baseCompilerOptions,
      types: compact([...(compilerOptions.types ?? []), ...baseCompilerOptions.types]),
      allowNonTsExtensions: true,
    };

    const [syncCompilers, asyncCompilers] = compilers;
    this.extensions = new Set([...DEFAULT_EXTENSIONS, ...getCompilerExtensions(compilers)]);
    this.syncCompilers = syncCompilers;
    this.asyncCompilers = asyncCompilers;
    this.isSkipLibs = isSkipLibs;
    this.isWatch = isWatch;

    this.cache = new CacheConsultant(`project-${n}`);
  }

  init() {
    const { fileManager, compilerHost, resolveModuleNames, languageServiceHost } = createHosts({
      cwd: this.cwd,
      compilerOptions: this.compilerOptions,
      entryPaths: this.entryPaths,
      compilers: [this.syncCompilers, this.asyncCompilers],
      isSkipLibs: this.isSkipLibs,
      useResolverCache: !this.isWatch,
    });

    this.backend = {
      fileManager,
      compilerHost,
      resolveModuleNames,
      languageServiceHost,
    };
  }

  addPaths(paths: ts.CompilerOptions['paths']) {
    this.compilerOptions.paths = { ...this.compilerOptions.paths, ...paths };
  }

  addCompilers(compilers: [SyncCompilers, AsyncCompilers]) {
    this.syncCompilers = new Map([...this.syncCompilers, ...compilers[0]]);
    this.asyncCompilers = new Map([...this.asyncCompilers, ...compilers[1]]);
    this.extensions = new Set([...this.extensions, ...getCompilerExtensions(compilers)]);
  }

  /**
   * `ts.createProgram()` resolves files starting from the provided entry/root files. Calling `program.getTypeChecker()`
   * binds files and symbols (including symbols and maps like `sourceFile.resolvedModules` and `sourceFile.symbols`)
   */
  private createProgram() {
    this.backend.program = tsCreateProgram(
      Array.from(this.entryPaths),
      this.compilerOptions,
      this.backend.compilerHost,
      this.backend.program
    );

    const typeChecker = timerify(this.backend.program.getTypeChecker);
    this.backend.typeChecker = typeChecker();
  }

  private hasAcceptedExtension(filePath: string) {
    return this.extensions.has(extname(filePath));
  }

  public addEntryPath(filePath: string, options?: { skipExportsAnalysis: boolean }) {
    if (!isInNodeModules(filePath) && this.hasAcceptedExtension(filePath)) {
      this.entryPaths.add(filePath);
      this.projectPaths.add(filePath);
      if (options?.skipExportsAnalysis) this.skipExportsAnalysis.add(filePath);
    }
  }

  public addEntryPaths(filePaths: Set<string> | string[], options?: { skipExportsAnalysis: boolean }) {
    for (const filePath of filePaths) this.addEntryPath(filePath, options);
  }

  public addProjectPath(filePath: string) {
    if (!isInNodeModules(filePath) && this.hasAcceptedExtension(filePath)) {
      this.projectPaths.add(filePath);
      this.deletedFiles.delete(filePath);
    }
  }

  // TODO Organize better
  deletedFiles = new Set();
  public removeProjectPath(filePath: string) {
    this.entryPaths.delete(filePath);
    this.projectPaths.delete(filePath);
    this.invalidateFile(filePath);
    this.deletedFiles.add(filePath);
  }

  public addReferencedDependencies(workspaceName: string, referencedDependencies: ReferencedDependencies) {
    for (const referencedDependency of referencedDependencies)
      this.referencedDependencies.add([...referencedDependency, workspaceName]);
  }

  /**
   * Compile files with async compilers _before_ `ts.createProgram()`, since the TypeScript hosts machinery is fully
   * synchronous (eg. `ts.sys.readFile` and `host.resolveModuleNames`)
   */
  public async runAsyncCompilers() {
    const add = timerify(this.backend.fileManager.compileAndAddSourceFile.bind(this.backend.fileManager));
    const extensions = Array.from(this.asyncCompilers.keys());
    const files = Array.from(this.projectPaths).filter(filePath => extensions.includes(extname(filePath)));
    for (const filePath of files) {
      await add(filePath);
    }
  }

  public getUsedResolvedFiles() {
    this.createProgram();
    const sourceFiles = this.getProgramSourceFiles();
    return Array.from(this.projectPaths).filter(filePath => sourceFiles.has(filePath));
  }

  private getProgramSourceFiles() {
    const programSourceFiles = this.backend.program?.getSourceFiles().map(sourceFile => sourceFile.fileName);
    return new Set(programSourceFiles);
  }

  public getUnreferencedFiles() {
    const sourceFiles = this.getProgramSourceFiles();
    return Array.from(this.projectPaths).filter(filePath => !sourceFiles.has(filePath));
  }

  private getResolvedModuleHandler(sourceFile: BoundSourceFile) {
    const getResolvedModule = this.backend.program?.getResolvedModule;
    const resolver = getResolvedModule
      ? (specifier: string) => getResolvedModule(sourceFile, specifier, /* mode */ undefined)
      : (specifier: string) => sourceFile.resolvedModules?.get(specifier, /* mode */ undefined);
    if (!this.isWatch) return resolver;

    // TODO It's either this awkward bit in watch mode to handle deleted files, or some large refactoring
    return (specifier: string) => {
      const m = resolver(specifier);
      if (m?.resolvedModule?.resolvedFileName && this.deletedFiles.has(m.resolvedModule.resolvedFileName)) return;
      return m;
    };
  }

  public analyzeSourceFile(filePath: string, options: Omit<GetImportsAndExportsOptions, 'skipExports'>) {
    const fd = this.cache.getFileDescriptor(filePath);
    if (!fd.changed && fd.meta?.data) return deserialize(fd.meta.data);

    if (!this.backend.typeChecker) throw new Error('Must initialize TypeChecker before source file analysis');

    // We request it from `fileManager` directly as `program` does not contain cross-referenced files
    const sourceFile: BoundSourceFile | undefined = this.backend.fileManager.getSourceFile(filePath);

    if (!sourceFile) throw new Error(`Unable to find ${filePath}`);

    const skipExports = this.skipExportsAnalysis.has(filePath);

    const { imports, exports, scripts } = _getImportsAndExports(
      sourceFile,
      this.getResolvedModuleHandler(sourceFile),
      this.backend.typeChecker,
      { ...options, skipExports }
    );

    const { internal, unresolved, external } = imports;

    const unresolvedImports = new Set<UnresolvedImport>();

    for (const unresolvedImport of unresolved) {
      const { specifier } = unresolvedImport;
      if (specifier.startsWith('http')) {
        // Ignore Deno style http import specifiers.
        continue;
      }
      const resolvedModule = this.resolveModule(specifier, filePath);
      if (resolvedModule) {
        if (resolvedModule.isExternalLibraryImport) {
          const sanitizedSpecifier = sanitizeSpecifier(specifier);
          external.add(sanitizedSpecifier);
        } else {
          const isIgnored = this.isGitIgnored(resolvedModule.resolvedFileName);
          if (!isIgnored) this.addEntryPath(resolvedModule.resolvedFileName, { skipExportsAnalysis: true });
        }
      } else {
        const sanitizedSpecifier = sanitizeSpecifier(specifier);
        if (isStartsLikePackageName(sanitizedSpecifier)) {
          // Should never end up here; maybe a dependency that was not installed.
          external.add(sanitizedSpecifier);
        } else {
          const isIgnored = this.isGitIgnored(join(dirname(filePath), sanitizedSpecifier));
          if (!isIgnored) {
            const ext = extname(sanitizedSpecifier);
            const hasIgnoredExtension = FOREIGN_FILE_EXTENSIONS.has(ext);
            if (!ext || (ext !== '.json' && !hasIgnoredExtension)) {
              unresolvedImports.add(unresolvedImport);
            }
          }
        }
      }
    }

    return {
      imports: {
        internal,
        unresolved: unresolvedImports,
        external,
      },
      exports,
      scripts,
    };
  }

  invalidateFile(filePath: string) {
    this.backend.fileManager.snapshotCache.delete(filePath);
    this.backend.fileManager.sourceFileCache.delete(filePath);
  }

  public resolveModule(specifier: string, filePath: string = specifier) {
    return this.backend.resolveModuleNames([specifier], filePath)[0];
  }

  public findUnusedMembers(filePath: string, members: SerializableExportMember[]) {
    if (!this.findReferences) {
      const languageService = ts.createLanguageService(this.backend.languageServiceHost, ts.createDocumentRegistry());
      this.findReferences = timerify(languageService.findReferences);
    }

    return members.filter(member => {
      if (member.jsDocTags.has('@public')) return false;
      const referencedSymbols = this.findReferences?.(filePath, member.pos);
      const files = (referencedSymbols ?? [])
        .flatMap(refs => refs.references)
        .filter(ref => !ref.isDefinition)
        .map(ref => ref.fileName);
      const internalRefs = files.filter(f => f === filePath);
      const externalRefs = files.filter(f => f !== filePath);
      return externalRefs.length === 0 && internalRefs.length === 0;
    });
  }

  public hasReferences(filePath: string, exportedItem: SerializableExport) {
    if (exportedItem.jsDocTags.has('@public')) return false;

    if (!this.findReferences) {
      const languageService = ts.createLanguageService(this.backend.languageServiceHost, ts.createDocumentRegistry());
      this.findReferences = timerify(languageService.findReferences);
    }

    const referencedSymbols = this.findReferences?.(filePath, exportedItem.pos);
    const files = (referencedSymbols ?? [])
      .flatMap(refs => refs.references)
      .filter(ref => !ref.isDefinition)
      .map(ref => ref.fileName);
    const externalRefs = files.filter(f => f !== filePath);
    return externalRefs.length > 0;
  }

  reconcileCache(serializableMap: SerializableMap) {
    for (const filePath in serializableMap) {
      const fd = this.cache.getFileDescriptor(filePath);
      if (!fd?.meta) continue;
      fd.meta.data = serialize(serializableMap[filePath]);
    }
    this.cache.reconcile();
  }
}
